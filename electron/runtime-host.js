"use strict";
/**
 * Owns the agent runtime child processes and bridges renderer `/api` calls to them.
 *
 * Runtimes are spawned with the bundled Node binary (not Electron's) because they
 * load native modules built for that ABI, and talk over the child IPC channel
 * rather than a loopback port — nothing about the desktop client is a web server
 * any more, so runtime stalls can never hold up the window's own assets.
 *
 * Protocol additions for the built-in browser (reverse direction):
 *   heavy runtime → main: { t:"browser", id, action, params }  (params.viewId always set)
 *   main → heavy runtime: { t:"browser-res", id, ok, data?, error? }
 * The handler is injected via setBrowserRequestHandler (browser-pool in main.js)
 * to avoid a circular require; the default replies "browser unavailable".
 */
const { spawn } = require("node:child_process");

const REQUEST_CHANNEL = "raincode-api:request";
const STREAM_OPEN_CHANNEL = "raincode-api:stream-open";
const STREAM_CLOSE_CHANNEL = "raincode-api:stream-close";
const STREAM_EVENT_CHANNEL = "raincode-api:stream";
const ABORT_CHANNEL = "raincode-api:abort";

/**
 * Two runtimes, split by whether a route needs the agent SDK.
 *
 * Loading the SDK + tool graph is ~5s warm and ~17s cold on Windows — 2400 files
 * of mostly filesystem cost — and it blocks its process for the duration. With a
 * single runtime the session list, file tree and git status queued behind it.
 * These paths reach none of it, so they get a process that never loads it.
 *
 * Misclassifying is safe in one direction only: the heavy runtime can serve
 * anything, so an unlisted path is merely as slow as before. A path listed here
 * that *does* reach the SDK would drag it into the light runtime — only add
 * routes verified free of it (no static `@earendil-works/*`, no ModelRuntime,
 * no SessionManager / session-entries / utility-model).
 *
 * Prefer EXACT matches for single routes. PREFIX matches must not cover sibling
 * subpaths that need the SDK (e.g. `/api/models-config` must NOT prefix-match
 * `/api/models-config/provider-models`).
 */
const LIGHT_EXACT = new Set([
  "/api/home",
  "/api/sessions",
  "/api/health",
  "/api/default-cwd",
  "/api/github",
  "/api/permissions",
  "/api/mcp",
  // hooks.json CRUD only — pure fs, same pattern as /api/mcp.
  "/api/hooks",
  // agents/*.md CRUD only — pure fs (own frontmatter parser, no SDK import).
  "/api/subagents",
  "/api/web-settings/events",
  // models.json CRUD only — subpaths that touch ModelRuntime stay heavy.
  "/api/models-config",
  "/api/skills/install",
  "/api/skills/search",
]);

const LIGHT_PREFIXES = [
  "/api/files/",
  "/api/git/",
  "/api/cwd/",
  "/api/worktrees",
  "/api/usage",
  "/api/app-update",
  "/api/file-index",
  "/api/diagnostics",
  "/api/commands",
  "/api/mcp",
  "/api/lsp",
  // Accounts are pure fs + fetch (device-code OAuth, no SDK):
  "/api/accounts",
  // models-config subpaths verified free of ModelRuntime / SDK:
  "/api/models-config/free-models",
  "/api/models-config/disabled-models",
  // provider-models without ?fresh=1 is routed in roleForPath (cache-only light).
  // NOT light: /model-overrides, /test, /discover (ModelRuntime)
  // NOT light: /api/debug/sessions (debug pool lives in heavy, same as the
  // PTY pin in roleForPath).
];

/** @param {string} rawPath */
function roleForPath(rawPath) {
  const raw = rawPath || "";
  const qIndex = raw.indexOf("?");
  const pathname = qIndex >= 0 ? raw.slice(0, qIndex) : raw;
  const query = qIndex >= 0 ? raw.slice(qIndex + 1) : "";

  // Built-in provider catalogs: default is cache-only (light). Live refresh
  // (?fresh=1) needs ModelRuntime and must stay on heavy.
  if (pathname === "/api/models-config/provider-models") {
    return new URLSearchParams(query).get("fresh") === "1" ? "heavy" : "light";
  }

  // Settings reads are the hot path and stay light. Effect-ful writes
  // (agentMode / leanMode, flagged via ?effects=1 by web-settings-store)
  // must run next to the session registry: their side effects iterate live
  // wrappers, which are process-local to heavy.
  if (pathname === "/api/web-settings") {
    return new URLSearchParams(query).get("effects") === "1" ? "heavy" : "light";
  }

  // The YOLO mode toggle syncs live session wrappers (registry is heavy-local);
  // plain reads stay light so merely opening the panel never boots the SDK.
  if (pathname === "/api/permissions") {
    return new URLSearchParams(query).get("sync") === "1" ? "heavy" : "light";
  }

  // Debug sessions live in the heavy runtime's process-local pool (the agent
  // debug tool creates them there) — same pin as PTY below.
  if (pathname === "/api/debug/sessions") return "heavy";

  if (LIGHT_EXACT.has(pathname)) return "light";
  // PTY sessions live in the heavy runtime's process-local registry — the agent
  // bash tool creates them there, so Terminal UI routes must run there too.
  if (pathname.startsWith("/api/cwd/pty")) return "heavy";
  return LIGHT_PREFIXES.some((prefix) => pathname.startsWith(prefix)) ? "light" : "heavy";
}

/** @type {{ light: import('node:child_process').ChildProcess | null, heavy: import('node:child_process').ChildProcess | null }} */
const children = { light: null, heavy: null };
let nextId = 0;
/** id → { resolve, reject, role } for buffered requests. */
const pending = new Map();
/** id → { webContents, streamId, role } for streaming requests. */
const streams = new Map();

function newId() {
  nextId += 1;
  return `r${nextId}`;
}

/**
 * Reverse-IPC entry for `{ t:"browser" }` messages, injected by main.js
 * (browser-pool) so this module never requires Electron UI code. Receives the
 * full message and resolves { ok, data } / { ok: false, error }.
 * @type {(message: object) => Promise<{ ok: boolean, data?: unknown, error?: string }>}
 */
let browserRequestHandler = async () => ({ ok: false, error: "browser unavailable" });

/** @param {(message: object) => Promise<{ ok: boolean, data?: unknown, error?: string }>} fn */
function setBrowserRequestHandler(fn) {
  browserRequestHandler = typeof fn === "function" ? fn : async () => ({ ok: false, error: "browser unavailable" });
}

/**
 * Replies to a `{ t:"browser" }` reverse request. The callback form of
 * proc.send is required — see sendToRuntime for why (EPIPE on exit).
 */
function replyBrowser(proc, id, payload) {
  try {
    if (!proc || !proc.connected) return;
    proc.send({ t: "browser-res", id, ...payload }, (error) => {
      if (error) console.warn(`[electron] browser-res send failed: ${error.message}`);
    });
  } catch {
    // runtime already gone
  }
}

function handleRuntimeMessage(message, proc, role) {
  if (!message || typeof message !== "object") return;
  const { t, id } = message;

  // Agent browser tool driving the main process's WebContentsView pool. Only
  // the heavy runtime runs agent tools — the light runtime must never drive UI.
  if (t === "browser") {
    if (role !== "heavy") {
      replyBrowser(proc, id, { ok: false, error: "browser actions are only available from the heavy runtime" });
      return;
    }
    Promise.resolve(browserRequestHandler(message)).then(
      (result) => {
        if (result && typeof result === "object" && "ok" in result) {
          replyBrowser(proc, id, result.ok
            ? { ok: true, data: result.data }
            : { ok: false, error: result.error || "browser request failed" });
        } else {
          replyBrowser(proc, id, { ok: true, data: result });
        }
      },
      (error) => replyBrowser(proc, id, { ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
    return;
  }

  if (t === "res") {
    pending.get(id)?.resolve({
      status: message.status,
      headers: message.headers,
      body: message.body,
    });
    pending.delete(id);
    return;
  }
  if (t === "err") {
    const waiter = pending.get(id);
    if (waiter) {
      waiter.reject(new Error(message.message || "runtime error"));
      pending.delete(id);
      return;
    }
  }

  const stream = streams.get(id);
  if (!stream) return;
  // Two sinks: renderer streams fan out over IPC to their WebContents;
  // non-renderer callers (the LAN HTTP adapter) pass an onEvent callback.
  if (stream.webContents) {
    if (stream.webContents.isDestroyed()) {
      streams.delete(id);
      return;
    }
    stream.webContents.send(STREAM_EVENT_CHANNEL, { ...message, streamId: stream.streamId });
  } else {
    stream.onEvent?.(message);
  }
  if (t === "end" || t === "err") streams.delete(id);
}

/**
 * @param {{ entry: string, cwd: string, env: NodeJS.ProcessEnv, nodeBinary: string,
 *           onLog?: (chunk: Buffer) => void, onExit?: (child: import('node:child_process').ChildProcess) => void }} options
 */
function startRuntime({ entry, cwd, env, nodeBinary, onLog, onExit }) {
  for (const role of ["light", "heavy"]) {
    console.log(`[electron] Starting ${role} agent runtime over IPC`);
    const proc = spawn(nodeBinary, [entry], {
      cwd,
      // The light runtime must never prewarm the builtin extensions — that is
      // exactly the SDK load this split keeps away from it.
      env: { ...env, RAINCODE_RUNTIME_ROLE: role },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      // Default JSON serialization on purpose: `serialization: "advanced"` is V8
      // structured clone, and Electron's V8 differs from the bundled Node's,
      // which fails the channel outright ("unsupported version"). Bodies cross
      // as base64 strings instead — see daemon/ipc-host.mjs.
    });
    proc.stdout?.on("data", (chunk) => {
      process.stdout.write(chunk);
      onLog?.(chunk);
    });
    proc.stderr?.on("data", (chunk) => {
      process.stderr.write(chunk);
      onLog?.(chunk);
    });
    proc.on("message", (message) => handleRuntimeMessage(message, proc, role));
    proc.on("exit", () => {
      children[role] = null;
      // Only fail what this runtime still owed an answer for.
      for (const [id, waiter] of pending) {
        if (waiter.role !== role) continue;
        waiter.reject(new Error(`${role} agent runtime exited`));
        pending.delete(id);
      }
      for (const [id, stream] of streams) {
        if (stream.role === role) streams.delete(id);
      }
    });
    children[role] = proc;
    onExit?.(proc);
  }
  return children.heavy;
}

function sendToRuntime(role, message) {
  const proc = children[role];
  if (!proc || !proc.connected) throw new Error(`${role} agent runtime is not running`);
  // The callback form is required, not optional: without it a failed write
  // (EPIPE while the runtime is exiting, e.g. on window close) surfaces as an
  // uncaught exception in the main process and Electron shows an error dialog.
  proc.send(message, (error) => {
    if (error) console.warn(`[electron] ${role} runtime send failed: ${error.message}`);
  });
}

/**
 * Non-renderer entry into the same runtime protocol — used by the LAN HTTP
 * adapter (electron/lan-server.js). Role classification, id allocation and the
 * pending/streams maps stay here so the child protocol has exactly one owner.
 *
 * Buffered: resolves { status, headers, body(base64) }.
 * Streaming (`stream: true`): events arrive via onEvent({ t:"open" | "chunk" |
 * "end" | "err", ...}) with base64 chunks; close() aborts in the runtime.
 *
 * @param {{ id?: string, method?: string, path: string, headers?: Record<string, string>,
 *           body?: string, bodyEncoding?: string, stream?: boolean,
 *           onEvent?: (message: object) => void }} options
 */
function requestRuntime({ id, method, path, headers, body, bodyEncoding, stream, onEvent }) {
  const reqId = id || newId();
  const role = roleForPath(path);
  if (stream) {
    streams.set(reqId, { onEvent, role });
    const close = () => {
      if (!streams.delete(reqId)) return;
      try {
        sendToRuntime(role, { t: "abort", id: reqId });
      } catch {
        // runtime already gone
      }
    };
    try {
      sendToRuntime(role, {
        t: "req",
        id: reqId,
        method: method || "GET",
        path,
        headers: headers || {},
        body,
        bodyEncoding,
        stream: true,
      });
    } catch (error) {
      streams.delete(reqId);
      onEvent?.({
        t: "err",
        id: reqId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return { id: reqId, close };
  }
  const result = new Promise((resolve, reject) => pending.set(reqId, { resolve, reject, role }));
  sendToRuntime(role, {
    t: "req",
    id: reqId,
    method: method || "GET",
    path,
    headers: headers || {},
    body,
    bodyEncoding,
  });
  return result;
}

/** @param {Electron.IpcMain} ipcMain */
function registerApiBridge(ipcMain) {
  ipcMain.handle(REQUEST_CHANNEL, async (_event, payload) => {
    return requestRuntime({
      id: payload?.requestId,
      method: payload?.method || "GET",
      path: payload?.path,
      headers: payload?.headers || {},
      body: payload?.body,
      bodyEncoding: payload?.bodyEncoding,
    });
  });

  // Without this an aborted fetch — a superseded session load, a sidebar poll
  // cancelled on unmount — keeps running in the runtime and its work piles up
  // behind whatever the user is actually waiting for.
  //
  // Resolve rather than reject: the abort channel is only ever fired by the
  // renderer that owns this requestId (from its own AbortSignal), and that
  // renderer already threw AbortError locally — the IPC reply is unobservable.
  // Rejecting would surface as "Error occurred in handler for
  // 'raincode-api:request'" log noise with no listener on the other end.
  const ABORTED_REPLY = { status: 499, headers: {}, body: "" };
  ipcMain.on(ABORT_CHANNEL, (_event, payload) => {
    const id = payload?.requestId;
    const waiter = pending.get(id);
    if (!waiter) return;
    pending.delete(id);
    waiter.resolve(ABORTED_REPLY);
    try {
      sendToRuntime(waiter.role, { t: "abort", id });
    } catch {
      // runtime already gone
    }
  });

  // One "destroyed" listener per WebContents, no matter how many SSE streams it
  // opens — a per-stream listener trips MaxListenersExceededWarning at 11.
  const streamedSenders = new Set();

  ipcMain.on(STREAM_OPEN_CHANNEL, (event, payload) => {
    const id = newId();
    const role = roleForPath(payload?.path);
    streams.set(id, { webContents: event.sender, streamId: payload?.streamId, role });
    // Renderer reloads leave orphaned streams; drop them with their window.
    if (!streamedSenders.has(event.sender)) {
      streamedSenders.add(event.sender);
      const sender = event.sender;
      sender.once("destroyed", () => {
        streamedSenders.delete(sender);
        for (const [sid, stream] of streams) {
          if (stream.webContents !== sender) continue;
          streams.delete(sid);
          try {
            sendToRuntime(stream.role, { t: "abort", id: sid });
          } catch {
            // runtime already gone
          }
        }
      });
    }
    try {
      sendToRuntime(role, {
        t: "req",
        id,
        method: "GET",
        path: payload?.path,
        headers: payload?.headers || {},
        stream: true,
      });
    } catch (error) {
      event.sender.send(STREAM_EVENT_CHANNEL, {
        t: "err",
        streamId: payload?.streamId,
        message: error instanceof Error ? error.message : String(error),
      });
      streams.delete(id);
    }
  });

  ipcMain.on(STREAM_CLOSE_CHANNEL, (_event, payload) => {
    for (const [id, stream] of streams) {
      if (stream.streamId !== payload?.streamId) continue;
      streams.delete(id);
      try {
        sendToRuntime(stream.role, { t: "abort", id });
      } catch {
        // runtime already gone
      }
      break;
    }
  });
}

/** The SDK-backed runtime — what callers mean by "the server process". */
function getRuntimeProcess() {
  return children.heavy;
}

module.exports = {
  startRuntime,
  registerApiBridge,
  getRuntimeProcess,
  setBrowserRequestHandler,
  handleRuntimeMessage,
  requestRuntime,
  roleForPath,
  LIGHT_EXACT,
  LIGHT_PREFIXES,
};
