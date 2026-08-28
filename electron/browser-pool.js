"use strict";
/**
 * Owns the pooled WebContentsView browser instances (keyed by opaque viewId,
 * at most one attached to the main window) used by the renderer browser panel
 * and the agent `browser` tool, plus their state broadcasts. Every view has a
 * CDP debugger attached from creation, capturing console + network activity
 * into capped per-view ring buffers so the agent can debug retroactively.
 */
const { WebContentsView, session, shell } = require("electron");

const NAVIGATE_TIMEOUT_MS = 30_000;
const SCREENSHOT_MAX_WIDTH = 1024;
const CONSOLE_CAP = 500;
const NETWORK_CAP = 300;
const BODY_TEXT_LIMIT = 8000;

/** @type {Map<string, Electron.WebContentsView>} viewId → view (opaque ids: agent session ids, "<sessionId>/<tab>" for extra tabs, or "scratch"). */
const views = new Map();
/** @type {Map<string, { wired: boolean, seq: number, console: object[], network: Map<string, object> }>} per-view CDP capture buffers. */
const debugState = new Map();
/** @type {string | null} viewId currently added to the window's contentView. */
let attachedViewId = null;
/** @type {Electron.BrowserWindow | null} window the attached view lives in. */
let attachedWindow = null;
/** @type {((state: object) => void) | null} main.js forwards this to the renderer. */
let stateListener = null;
/** @type {Electron.Session | null} shared so logins persist across views/sessions. */
let browserSession = null;

function getBrowserSession() {
  if (!browserSession) browserSession = session.fromPartition("persist:raincode-browser");
  return browserSession;
}

/** @param {(state: object) => void} listener */
function setStateListener(listener) {
  stateListener = listener;
}

/** @param {string} viewId */
function computeState(viewId) {
  const view = views.get(viewId);
  if (!view || view.webContents.isDestroyed()) {
    return { viewId, url: "", title: "", loading: false, canGoBack: false, canGoForward: false };
  }
  const wc = view.webContents;
  return {
    viewId,
    url: wc.getURL(),
    title: wc.getTitle(),
    loading: wc.isLoading(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
  };
}

/** @param {string} viewId */
function emitState(viewId) {
  if (!stateListener) return;
  try {
    stateListener(computeState(viewId));
  } catch {
    // A destroyed window must never take the pool down.
  }
}

/** @param {string} viewId */
function ensureDebugState(viewId) {
  let st = debugState.get(viewId);
  if (!st) {
    st = { wired: false, seq: 0, console: [], network: new Map() };
    debugState.set(viewId, st);
  }
  return st;
}

/** RemoteObject → short printable string (console arg formatting). */
function formatRemoteObject(arg) {
  if (!arg || typeof arg !== "object") return String(arg);
  if ("value" in arg) return typeof arg.value === "string" ? arg.value : JSON.stringify(arg.value);
  return arg.description || arg.unserializableValue?.toString() || arg.type || "?";
}

/** @param {object} st @param {object} entry */
function pushConsole(st, entry) {
  st.console.push({ seq: ++st.seq, ts: Date.now(), ...entry });
  if (st.console.length > CONSOLE_CAP) st.console.splice(0, st.console.length - CONSOLE_CAP);
}

/** CDP event fan-in for one view: console API, exceptions, Log domain, Network domain. */
function wireDebugCapture(viewId, wc, st) {
  wc.debugger.on("message", (_event, method, params) => {
    if (method === "Runtime.consoleAPICalled") {
      pushConsole(st, {
        level: params.type,
        text: (params.args || []).map(formatRemoteObject).join(" ").slice(0, 500),
      });
    } else if (method === "Runtime.exceptionThrown") {
      const d = params.exceptionDetails || {};
      pushConsole(st, {
        level: "error",
        text: (d.exception?.description || d.text || "uncaught exception").slice(0, 500),
      });
    } else if (method === "Log.entryAdded") {
      const e = params.entry || {};
      pushConsole(st, { level: e.level || "log", text: `[${e.source || "log"}] ${String(e.text || "").slice(0, 480)}` });
    } else if (method === "Network.requestWillBeSent") {
      const req = params.request || {};
      // Redirects re-fire with the same requestId — keep one entry per request.
      st.network.set(params.requestId, {
        seq: ++st.seq,
        id: params.requestId,
        method: req.method,
        url: req.url,
        type: params.type || "other",
        ts: params.wallTime ? Math.round(params.wallTime * 1000) : Date.now(),
      });
      if (st.network.size > NETWORK_CAP) st.network.delete(st.network.keys().next().value);
    } else if (method === "Network.responseReceived") {
      const entry = st.network.get(params.requestId);
      if (entry) {
        entry.status = params.response?.status;
        entry.mimeType = params.response?.mimeType;
      }
    } else if (method === "Network.loadingFinished") {
      const entry = st.network.get(params.requestId);
      if (entry) entry.sizeKB = Math.round((params.encodedDataLength || 0) / 102.4) / 10;
    } else if (method === "Network.loadingFailed") {
      const entry = st.network.get(params.requestId);
      if (entry) entry.failed = String(params.errorText || "failed");
    }
  });
}

/**
 * Attach the CDP debugger (idempotent) and enable the capture domains once per
 * view, so console/network history exists from the very first navigation.
 */
function attachDebugger(viewId, wc) {
  try {
    wc.debugger.attach("1.3");
  } catch (error) {
    if (!/already attached/i.test(String(error?.message || error))) throw error;
  }
  const st = ensureDebugState(viewId);
  if (!st.wired) {
    st.wired = true;
    wireDebugCapture(viewId, wc, st);
    for (const domain of ["Runtime.enable", "Log.enable", "Network.enable"]) {
      void wc.debugger.sendCommand(domain).catch(() => {});
    }
  }
  return st;
}

/** @param {string} viewId */
function ensureView(viewId) {
  const existing = views.get(viewId);
  if (existing && !existing.webContents.isDestroyed()) return existing;
  const view = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      session: getBrowserSession(),
    },
  });
  const wc = view.webContents;
  // Agent browsing must keep running while the view is detached from the window.
  wc.setBackgroundThrottling(false);
  // Same policy as the main window: never open in-app windows, defer to the OS browser.
  wc.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  const notify = () => emitState(viewId);
  for (const eventName of [
    "did-navigate",
    "did-navigate-in-page",
    "page-title-updated",
    "did-start-loading",
    "did-stop-loading",
    "did-fail-load",
  ]) {
    wc.on(eventName, notify);
  }
  views.set(viewId, view);
  // CDP capture from creation: console/network buffers must cover the first
  // navigation, not just the moment the agent thinks to look. A main-frame
  // navigation starts a fresh page — reset the buffers with it.
  attachDebugger(viewId, wc);
  wc.on("did-navigate", () => {
    const st = ensureDebugState(viewId);
    st.console = [];
    st.network = new Map();
  });
  return view;
}

/** CSS px == DIPs for WebContentsView bounds — do NOT scale. */
function normalizeRect(rect) {
  const r = rect && typeof rect === "object" ? rect : {};
  return {
    x: Math.max(0, Math.round(Number(r.x) || 0)),
    y: Math.max(0, Math.round(Number(r.y) || 0)),
    width: Math.max(0, Math.round(Number(r.width) || 0)),
    height: Math.max(0, Math.round(Number(r.height) || 0)),
  };
}

function detachAttachedView() {
  if (!attachedViewId) return;
  const view = views.get(attachedViewId);
  if (view && attachedWindow && !attachedWindow.isDestroyed()) {
    try {
      attachedWindow.contentView.removeChildView(view);
    } catch {
      // already detached
    }
  }
  attachedViewId = null;
  attachedWindow = null;
}

/** Bare hosts get https://; anything already carrying a scheme passes through. */
function withScheme(url) {
  const raw = String(url || "").trim();
  if (!raw) throw new Error("url is required");
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) ? raw : `https://${raw}`;
}

/** Resolves with the post-load BrowserState; rejects with the did-fail-load description. */
function navigateView(viewId, url) {
  const view = ensureView(viewId);
  const wc = view.webContents;
  const target = withScheme(url);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      wc.removeListener("did-fail-load", onFailLoad);
      if (error) reject(error);
      else resolve(computeState(viewId));
    };
    const timer = setTimeout(() => {
      finish(new Error(`Navigation timed out after ${NAVIGATE_TIMEOUT_MS / 1000}s: ${target}`));
    }, NAVIGATE_TIMEOUT_MS);
    const onFailLoad = (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
      if (!isMainFrame) return;
      // ERR_ABORTED: a newer navigation superseded this one — not a failure.
      if (errorCode === -3) {
        finish(null);
        return;
      }
      finish(new Error(errorDescription || `Navigation failed (${errorCode})`));
    };
    wc.on("did-fail-load", onFailLoad);
    wc.loadURL(target).then(
      () => finish(null),
      (error) => {
        // loadURL also rejects on did-fail-load (already handled) and on
        // ERR_ABORTED when another load cut in — both tolerated above.
        if (String(error?.message || error).includes("ERR_ABORTED")) finish(null);
        else finish(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function evaluateInView(viewId, expression) {
  const wc = ensureView(viewId).webContents;
  attachDebugger(viewId, wc);
  const result = await wc.debugger.sendCommand("Runtime.evaluate", {
    expression: String(expression ?? ""),
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    throw new Error(details.exception?.description || details.text || "Evaluation failed");
  }
  return result.result?.value;
}

async function screenshotView(viewId) {
  const wc = ensureView(viewId).webContents;
  const image = await wc.capturePage();
  const size = image.getSize();
  // A detached/hidden view captures as 0x0 with an empty PNG — returning it
  // would poison the session context (providers reject empty image blocks).
  if (!size.width || !size.height) {
    throw new Error(
      `Screenshot unavailable: view has no rendered content (${size.width}x${size.height}). ` +
        `The browser view is likely detached — show the Browser panel, then retry.`,
    );
  }
  let final = image;
  if (size.width > SCREENSHOT_MAX_WIDTH) {
    final = image.resize({
      width: SCREENSHOT_MAX_WIDTH,
      height: Math.round((size.height * SCREENSHOT_MAX_WIDTH) / size.width),
    });
  }
  const finalSize = final.getSize();
  const png = final.toPNG();
  if (!png.length) {
    throw new Error("Screenshot unavailable: capture produced an empty image.");
  }
  return {
    dataBase64: png.toString("base64"),
    width: finalSize.width,
    height: finalSize.height,
  };
}

async function destroyView(viewId) {
  const view = views.get(viewId);
  if (!view) return;
  if (attachedViewId === viewId) detachAttachedView();
  views.delete(viewId);
  debugState.delete(viewId);
  try {
    if (!view.webContents.isDestroyed()) view.webContents.destroy();
  } catch {
    // already gone
  }
}

/** A session teardown takes its whole tab tree ("<base>" plus "<base>/<tab>"). */
async function destroyViewTree(baseViewId) {
  const doomed = [...views.keys()].filter((id) => id === baseViewId || id.startsWith(`${baseViewId}/`));
  for (const id of doomed) await destroyView(id);
}

/** Tabs of one session: the base view is "main", siblings are "<base>/<tab>". */
function listViews(baseViewId) {
  const out = [];
  for (const [id, view] of views) {
    if (id !== baseViewId && !id.startsWith(`${baseViewId}/`)) continue;
    const wc = view.webContents;
    out.push({
      tab: id === baseViewId ? "main" : id.slice(baseViewId.length + 1),
      url: wc.isDestroyed() ? "" : wc.getURL(),
      title: wc.isDestroyed() ? "" : wc.getTitle(),
    });
  }
  return out;
}

/**
 * Renderer ops (preload `raincodeDesktop.browser.*`). Returns BrowserState for
 * attach/navigate/getState, undefined otherwise; rejections surface as invoke errors.
 */
async function handleRenderer(payload, getWindow) {
  const op = payload?.op;
  const viewId = String(payload?.viewId || "");
  switch (op) {
    case "attach": {
      if (!viewId) throw new Error("viewId is required");
      const view = ensureView(viewId);
      const win = getWindow();
      if (win && !win.isDestroyed()) {
        detachAttachedView();
        win.contentView.addChildView(view);
        if (payload?.rect) view.setBounds(normalizeRect(payload.rect));
        // The panel card is rounded; the native view paints above the DOM and
        // ignores CSS clipping, so its corners must be rounded natively.
        const radius = Number(payload?.radius);
        if (Number.isFinite(radius)) view.setBorderRadius(Math.max(0, Math.round(radius)));
        attachedViewId = viewId;
        attachedWindow = win;
      }
      const state = computeState(viewId);
      emitState(viewId);
      return state;
    }
    case "detach": {
      detachAttachedView();
      return undefined;
    }
    case "setBounds": {
      if (attachedViewId && payload?.rect) {
        views.get(attachedViewId)?.setBounds(normalizeRect(payload.rect));
      }
      return undefined;
    }
    case "navigate": {
      if (!viewId) throw new Error("viewId is required");
      return navigateView(viewId, payload?.url);
    }
    case "goBack":
    case "goForward":
    case "reload": {
      if (!viewId) throw new Error("viewId is required");
      const wc = ensureView(viewId).webContents;
      if (op === "goBack" && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
      if (op === "goForward" && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
      if (op === "reload") wc.reload();
      return undefined;
    }
    case "getState": {
      if (!viewId) throw new Error("viewId is required");
      return computeState(viewId);
    }
    case "list": {
      if (!viewId) throw new Error("viewId is required");
      return listViews(viewId);
    }
    case "close": {
      if (!viewId) throw new Error("viewId is required");
      await destroyView(viewId);
      emitState(viewId);
      return undefined;
    }
    default:
      throw new Error(`unknown browser op: ${op}`);
  }
}

/** Agent runtime ops. Never rejects: resolves { ok, data } / { ok: false, error }. */
async function handleRuntime(action, params) {
  try {
    const viewId = String(params?.viewId || "");
    if (!viewId) return { ok: false, error: "viewId is required" };
    switch (action) {
      case "navigate":
        return { ok: true, data: await navigateView(viewId, params?.url) };
      case "evaluate":
        return { ok: true, data: await evaluateInView(viewId, params?.expression) };
      case "screenshot":
        return { ok: true, data: await screenshotView(viewId) };
      case "goBack":
      case "goForward":
      case "reload":
      case "stop": {
        const wc = ensureView(viewId).webContents;
        if (action === "goBack" && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
        if (action === "goForward" && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
        if (action === "reload") wc.reload();
        if (action === "stop") wc.stop();
        return { ok: true, data: computeState(viewId) };
      }
      case "getState":
        return { ok: true, data: computeState(viewId) };
      case "list":
        return { ok: true, data: listViews(viewId) };
      case "getConsole": {
        const st = ensureDebugState(viewId);
        const since = Number(params?.sinceSeq) || 0;
        return { ok: true, data: { entries: st.console.filter((e) => e.seq > since), lastSeq: st.seq } };
      }
      case "getNetwork": {
        const st = ensureDebugState(viewId);
        const since = Number(params?.sinceSeq) || 0;
        return { ok: true, data: { entries: [...st.network.values()].filter((e) => e.seq > since), lastSeq: st.seq } };
      }
      case "getResponseBody": {
        const requestId = String(params?.requestId || "");
        if (!requestId) return { ok: false, error: "requestId is required" };
        const wc = ensureView(viewId).webContents;
        attachDebugger(viewId, wc);
        try {
          const res = await wc.debugger.sendCommand("Network.getResponseBody", { requestId });
          let body = res.base64Encoded ? Buffer.from(res.body || "", "base64").toString("utf8") : String(res.body || "");
          if (body.length > BODY_TEXT_LIMIT) body = `${body.slice(0, BODY_TEXT_LIMIT)}… (truncated)`;
          return { ok: true, data: { body } };
        } catch (error) {
          return { ok: false, error: `response body unavailable: ${error instanceof Error ? error.message : String(error)}` };
        }
      }
      case "close":
        // Single tab, exact viewId — unlike destroy, which tears down the tree.
        await destroyView(viewId);
        emitState(viewId);
        return { ok: true };
      case "destroy":
        await destroyViewTree(viewId);
        return { ok: true };
      default:
        return { ok: false, error: `unknown browser action: ${action}` };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** App quit: drop every view. */
function destroyAll() {
  detachAttachedView();
  for (const [viewId, view] of views) {
    views.delete(viewId);
    try {
      if (!view.webContents.isDestroyed()) view.webContents.destroy();
    } catch {
      // already gone
    }
  }
}

module.exports = {
  ensureView,
  setStateListener,
  handleRenderer,
  handleRuntime,
  destroyAll,
};
