/**
 * First-party hooks runtime — runs user-defined shell commands on agent
 * lifecycle events. Config lives in lib/hooks-config.ts (hooks.json files);
 * this module only reads it fresh per event and executes. tool_call hooks
 * block with exit code 2 (stderr becomes the reason); other failures notify
 * without interrupting the turn. All hook runs serialize through one
 * per-session chain so overlapping events cannot double-spawn a command.
 */
import { spawn } from "child_process";
import type {
  AgentEndEvent,
  BeforeAgentStartEvent,
  ExtensionContext,
  InlineExtension,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import {
  hookMatchesTool,
  readScopeHooks,
  HOOK_MATCHER_EVENTS,
  HOOK_TIMEOUT_DEFAULT,
  type HookDefinition,
} from "../hooks-config";

/** Stderr tail attached to block reasons / failure notices. */
const STDERR_TAIL_CHARS = 400;
/** Cap captured child output so a chatty hook cannot balloon memory. */
const OUTPUT_CAP_CHARS = 200_000;
/** Grace between SIGTERM and SIGKILL on timeout. */
const KILL_GRACE_MS = 3_000;
/** session_shutdown runs during teardown; never let it stall teardown long. */
const SHUTDOWN_TIMEOUT_CAP_SECONDS = 15;

type HookableEvent =
  | SessionStartEvent
  | BeforeAgentStartEvent
  | ToolCallEvent
  | ToolResultEvent
  | AgentEndEvent
  | SessionBeforeCompactEvent
  | SessionCompactEvent
  | SessionShutdownEvent;

type HookRunOutcome = {
  /** exit code 2 on a tool_call hook */
  blocked: boolean;
  failed: boolean;
  code: number | null;
  timedOut: boolean;
  stderr: string;
};

function sessionIdOf(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager.getSessionId() || undefined;
  } catch {
    return undefined;
  }
}

function isProjectTrusted(ctx: ExtensionContext): boolean {
  try {
    return ctx.isProjectTrusted() === true;
  } catch {
    return false;
  }
}

function buildPayload(event: HookableEvent, ctx: ExtensionContext): Record<string, unknown> {
  const base: Record<string, unknown> = {
    event: event.type,
    sessionId: sessionIdOf(ctx),
    cwd: ctx.cwd,
  };
  switch (event.type) {
    case "session_start":
      base.reason = event.reason;
      break;
    case "before_agent_start":
      base.prompt = event.prompt;
      break;
    case "tool_call":
      base.toolName = event.toolName;
      base.toolCallId = event.toolCallId;
      base.input = event.input;
      break;
    case "tool_result":
      base.toolName = event.toolName;
      base.toolCallId = event.toolCallId;
      base.isError = event.isError;
      break;
    case "agent_end":
      base.messageCount = event.messages.length;
      break;
    case "session_before_compact":
    case "session_compact":
      base.reason = event.reason;
      break;
    case "session_shutdown":
      break;
  }
  return base;
}

function buildHookEnv(event: HookableEvent, ctx: ExtensionContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.RC_HOOK_EVENT = event.type;
  env.RC_CWD = ctx.cwd;
  const sessionId = sessionIdOf(ctx);
  if (sessionId) env.RC_SESSION_ID = sessionId;
  if (event.type === "tool_call" || event.type === "tool_result") {
    env.RC_TOOL_NAME = String(event.toolName);
    env.RC_TOOL_CALL_ID = event.toolCallId;
  }
  return env;
}

function shellForCommand(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") {
    return { file: "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
  return { file: "/bin/sh", args: ["-c", command] };
}

function tail(text: string, maxChars: number): string {
  const trimmed = text.trim();
  return trimmed.length > maxChars ? trimmed.slice(-maxChars) : trimmed;
}

function runHookCommand(
  hook: HookDefinition,
  payloadJson: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs: number,
): Promise<HookRunOutcome> {
  return new Promise((resolveRun) => {
    const { file, args } = shellForCommand(hook.command);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      resolveRun({ blocked: false, failed: true, code: null, timedOut: false, stderr: e instanceof Error ? e.message : String(e) });
      return;
    }

    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }, KILL_GRACE_MS);
    }, timeoutMs);

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({
        blocked: code === 2,
        failed: code !== 0,
        code,
        timedOut,
        stderr: tail(stderr, STDERR_TAIL_CHARS),
      });
    };

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < OUTPUT_CAP_CHARS) stderr += chunk.toString("utf8");
    });
    child.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ blocked: false, failed: true, code: null, timedOut, stderr: err.message });
    });
    child.on("close", (code) => finish(code));

    // A hook that never reads stdin must not crash on EPIPE.
    child.stdin?.on("error", () => {});
    child.stdin?.end(payloadJson);
  });
}

function hooksForEvent(ctx: ExtensionContext, event: HookableEvent): HookDefinition[] {
  const items = readScopeHooks("user", ctx.cwd);
  if (isProjectTrusted(ctx)) items.push(...readScopeHooks("project", ctx.cwd));
  const usesMatcher = (HOOK_MATCHER_EVENTS as readonly string[]).includes(event.type);
  return items.filter((hook) => {
    if (hook.enabled === false || hook.event !== event.type) return false;
    return usesMatcher ? hookMatchesTool(hook, String((event as ToolCallEvent).toolName)) : true;
  });
}

function notifyHookFailure(ctx: ExtensionContext, hook: HookDefinition, result: HookRunOutcome): void {
  try {
    const detail = result.timedOut
      ? "timed out"
      : `exit code ${result.code ?? "unknown"}`;
    const tailText = result.stderr ? `\n${tail(result.stderr, STDERR_TAIL_CHARS)}` : "";
    ctx.ui.notify(`[hook] ${hook.name}: ${detail}${tailText}`, "warning");
  } catch {
    // No interactive UI (headless / teardown) — nothing to surface to.
  }
}

export function createHooksInlineExtension(): InlineExtension {
  return {
    name: "hooks",
    factory(pi) {
      // One chain per session: hooks run sequentially in definition order even
      // when two lifecycle events land back-to-back.
      let chain: Promise<unknown> = Promise.resolve();
      const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
        const run = chain.then(fn, fn);
        chain = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      };

      const fireHooks = (ctx: ExtensionContext, event: HookableEvent): Promise<ToolCallEventResult | void> =>
        enqueue(async () => {
          const hooks = hooksForEvent(ctx, event);
          if (hooks.length === 0) return;
          const payloadJson = JSON.stringify(buildPayload(event, ctx));
          const env = buildHookEnv(event, ctx);
          for (const hook of hooks) {
            if (ctx.signal?.aborted) return;
            const configured = hook.timeoutSeconds ?? HOOK_TIMEOUT_DEFAULT;
            const timeoutSeconds = event.type === "session_shutdown"
              ? Math.min(configured, SHUTDOWN_TIMEOUT_CAP_SECONDS)
              : configured;
            const result = await runHookCommand(hook, payloadJson, env, ctx.cwd, timeoutSeconds * 1000);
            if (event.type === "tool_call" && result.blocked) {
              const reason = result.stderr
                ? tail(result.stderr, STDERR_TAIL_CHARS)
                : `Blocked by hook "${hook.name}" (exit code 2)`;
              return { block: true, reason };
            }
            if (result.failed && event.type !== "session_shutdown") {
              notifyHookFailure(ctx, hook, result);
            }
          }
        });

      pi.on("session_start", async (event, ctx) => {
        await fireHooks(ctx, event);
      });
      pi.on("before_agent_start", async (event, ctx) => {
        await fireHooks(ctx, event);
      });
      pi.on("tool_call", (event, ctx) => fireHooks(ctx, event));
      pi.on("tool_result", async (event, ctx) => {
        await fireHooks(ctx, event);
      });
      pi.on("agent_end", async (event, ctx) => {
        await fireHooks(ctx, event);
      });
      pi.on("session_before_compact", async (event, ctx) => {
        await fireHooks(ctx, event);
      });
      pi.on("session_compact", async (event, ctx) => {
        await fireHooks(ctx, event);
      });
      pi.on("session_shutdown", async (event, ctx) => {
        await fireHooks(ctx, event);
      });
    },
  };
}
