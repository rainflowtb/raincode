/**
 * Bash tool for RainCode — Hermes-style foreground/background discipline.
 *
 * Routing:
 * - Short / normal commands → local non-PTY exec (never touches Terminal UI)
 * - Long-running / server-style commands → real PTY mirrored in the Terminal
 *   panel. The tool returns after a startup window so the agent is not blocked;
 *   the process keeps running until the user stops it in Terminal (or it exits).
 *
 * Intent is EXPLICIT, modeled on Hermes Desktop (NousResearch/hermes-agent):
 * the bash tool schema carries a `background` parameter, and foreground calls
 * that look like long-lived services (or shell background hacks like nohup /
 * setsid / trailing `&`) are REJECTED with corrective guidance — the error
 * message teaches the model to retry with `background: true`. Enforcement at
 * the tool boundary beats advisory prompt text.
 *
 * The `background` argument cannot reach `operations.exec` through pi's built-in
 * bash execute (it only forwards {command, timeout}), so the wrapper passes it
 * through an AsyncLocalStorage cell — safe under concurrent tool calls.
 */
import { AsyncLocalStorage } from "async_hooks";
import {
  createBashToolDefinition,
  createLocalBashOperations,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type BashOperations,
} from "@earendil-works/pi-coding-agent";
import { createPtySession, destroyPtySession, getPtySession, subscribePtySession } from "./pty-sessions";
import { claimJobReport, killJob, startJob } from "./background-jobs";
import { foregroundGuardrail, looksLikeLongRunningCommand } from "./bash-command-classification";
import { withProjectCommandEnvironment } from "./project-command-env";

/** How long to stream startup logs into the tool result before detaching. */
const LONG_RUNNING_STARTUP_MS = 2_500;

/** Per-call intent set by the wrapped execute, read by operations.exec. */
const bashCallIntent = new AsyncLocalStorage<{ background?: boolean }>();

// ── PTY execution (background services) ──────────────────────────────────────

function createAgentPtyBashOperations(options?: {
  /** Optional chat/agent session id for Terminal tab grouping. */
  getAgentSessionId?: () => string | undefined;
}): BashOperations {
  const local = createLocalBashOperations();

  const ptyExec: BashOperations["exec"] = async (command, cwd, { onData, signal, env }) => {
    if (signal?.aborted) throw new Error("aborted");

    const info = await createPtySession({
      cwd,
      command,
      source: "agent",
      agentSessionId: options?.getAgentSessionId?.(),
      title: command,
      env,
      cols: 100,
      rows: 32,
      publish: true,
    });
    // Job preflight after spawn is deliberate here: startJob throws on the
    // per-session cap; the PTY we just created must not leak on that path.
    let job;
    try {
      job = startJob({ label: command, ptyId: info.id, ownerSessionId: options?.getAgentSessionId?.() });
    } catch (error) {
      try { destroyPtySession(info.id); } catch { /* ignore */ }
      throw error;
    }

    return await new Promise<{ exitCode: number | null }>((resolve, reject) => {
      let settled = false;
      const timers: { startup?: ReturnType<typeof setTimeout> } = {};
      let unsub: (() => void) | undefined;
      let sawExit = false;

      const detachTool = (exitCode: number | null, note?: string) => {
        if (settled) return;
        settled = true;
        if (timers.startup) clearTimeout(timers.startup);
        try { unsub?.(); } catch { /* ignore */ }
        if (signal) signal.removeEventListener("abort", onAbort);
        if (note) {
          try {
            onData(Buffer.from(note, "utf8"));
          } catch {
            // ignore
          }
        }
        resolve({ exitCode });
      };

      const onAbort = () => {
        // User/agent abort still kills the process.
        try { killJob(job.id); } catch { /* ignore */ }
        if (settled) return;
        settled = true;
        if (timers.startup) clearTimeout(timers.startup);
        try { unsub?.(); } catch { /* ignore */ }
        if (signal) signal.removeEventListener("abort", onAbort);
        reject(new Error("aborted"));
      };

      try {
        unsub = subscribePtySession(info.id, (event) => {
          if (event.type === "data") {
            onData(Buffer.from(event.data, "utf8"));
          } else if (event.type === "exit") {
            sawExit = true;
            // Real process exit (crash or quick command) — return actual code.
            // The result is delivered inline, so suppress the completion notice.
            claimJobReport(job.id);
            detachTool(event.exitCode ?? 0);
          }
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      // After startup window: hand the process to the Terminal UI + job
      // registry and free the agent. Do NOT kill on model-provided timeouts.
      timers.startup = setTimeout(() => {
        if (settled || sawExit) return;
        const still = getPtySession(info.id);
        if (!still) {
          // Session was destroyed (tab closed / pruned). The job settled via
          // the exit path; the output so far is the inline delivery.
          claimJobReport(job.id);
          detachTool(
            null,
            "\n[RainCode] Terminal session was closed before the process finished.\n",
          );
          return;
        }
        if (still.exited) {
          // Exit raced with the startup window; report the real code.
          claimJobReport(job.id);
          detachTool(still.exitCode ?? 0);
          return;
        }
        detachTool(
          0,
          `\n[RainCode] Background job ${job.id} is running in the user's Terminal panel. `
          + `Use job_output (job_id: "${job.id}") to read new output and job_kill to stop it. `
          + "You are notified in-session when it exits.\n",
        );
      }, LONG_RUNNING_STARTUP_MS);
      timers.startup.unref?.();
    });
  };

  return withProjectCommandEnvironment({
    exec: async (command, cwd, execOptions) => {
      // Explicit background intent from the wrapped tool definition, or the
      // long-running heuristic as a fallback — both take the PTY path.
      const forceBackground = bashCallIntent.getStore()?.background === true;
      if (forceBackground || looksLikeLongRunningCommand(command)) {
        // Long-running: ignore tool timeout for killing — process is owned by Terminal.
        return ptyExec(command, cwd, execOptions);
      }
      // Normal short commands stay out of the Terminal UI.
      return local.exec(command, cwd, execOptions);
    },
  });
}

// ── Tool definition wrapper (schema + description + guardrail) ───────────────

const BACKGROUND_PARAM_DESCRIPTION =
  "Set true for long-lived processes that keep running (dev servers, watchers, daemons). " +
  "The process is moved into the user's Terminal panel and keeps running after the tool returns.";

const PI_WEB_BASH_DESCRIPTION =
  `Execute a bash command in the current working directory. Returns stdout and stderr. ` +
  `Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB ` +
  `(whichever is hit first). If truncated, full output is saved to a temp file.\n\n` +
  `Foreground (default): for commands that finish — builds, tests, installs, git, scripts, ` +
  `one-off checks. The call returns as soon as the command exits, so set timeout generously ` +
  `for long builds; you still get the result the moment it finishes.\n\n` +
  `Background (background: true): for long-lived processes that keep running — dev servers, ` +
  `watchers, daemons (npm run dev, vite, next dev, uvicorn, docker compose up, ...). The ` +
  `process is moved into the user's Terminal panel and tracked as a background job: the tool ` +
  `returns startup output after a short warmup window plus a job id. Read new output with ` +
  `job_output, stop it with job_kill, list with job_list. You are notified when it exits.\n\n` +
  `Rules:\n` +
  `- NEVER run servers/watchers in foreground mode — such calls are rejected with guidance. ` +
  `Retry with background: true.\n` +
  `- Do NOT use shell-level background wrappers (nohup, setsid, disown, trailing &) in ` +
  `foreground mode — they are rejected too. background: true gives tracked lifecycle and ` +
  `output instead.\n` +
  `- After starting a service in background, verify readiness once (health endpoint, or ` +
  `job_output with wait: true), then report the access URL to the user. You are notified ` +
  `when a background job exits — do not busy-poll it.`;

const PI_WEB_BASH_PROMPT_GUIDELINES = [
  "Start dev servers / watchers with bash background: true — they keep running in the user's Terminal panel as tracked jobs; foreground server commands are rejected.",
  "Track every background job id you start. You are notified in-session when a job exits — do not busy-poll or sleep on it. Use job_output (wait: true) only when genuinely blocked, and job_kill jobs that stopped mattering.",
  "Use bash for terminal work (git, builds, installs). Do not use it for cat/sed/file search, and do not launch Playwright or Chrome as a stand-in for MCP.",
];
type BashToolDefinitionLike = {
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: { properties: Record<string, unknown> };
  execute: (
    toolCallId: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<unknown>;
};

/**
 * Create the RainCode bash tool: pi's built-in bash tool extended with an
 * explicit `background` parameter and Hermes-style foreground guardrails.
 */
export function createRainCodeBashToolDefinition(
  cwd: string,
  options?: { getAgentSessionId?: () => string | undefined },
): ReturnType<typeof createBashToolDefinition> {
  const def = createBashToolDefinition(cwd, {
    operations: createAgentPtyBashOperations(options),
  }) as unknown as BashToolDefinitionLike;

  // 1. Schema: add the explicit intent parameter (TypeBox schemas are plain JSON).
  //    Note: pi shares one module-level bashSchema across definitions, so this
  //    mutation is process-wide — idempotent and uniform here because every
  //    RainCode bash tool is created through this factory.
  def.parameters.properties.background = {
    type: "boolean",
    description: BACKGROUND_PARAM_DESCRIPTION,
  };

  // 2. Description + system-prompt guidelines carry the foreground/background rules.
  def.description = PI_WEB_BASH_DESCRIPTION;
  def.promptSnippet = "Run shell commands (builds, git, installs — not file reads or a browser)";
  def.promptGuidelines = PI_WEB_BASH_PROMPT_GUIDELINES;

  // 3. Wrap execute: reject misused foreground calls with corrective guidance,
  //    and pass the background intent down to operations.exec via ALS.
  const originalExecute = def.execute;
  def.execute = (toolCallId, args, signal, onUpdate, ctx) => {
    const command = typeof args?.command === "string" ? args.command : "";
    const background = args?.background === true;

    if (!background && command) {
      const guidance = foregroundGuardrail(command);
      if (guidance) {
        // Tool error → the model reads the guidance and retries correctly.
        return Promise.reject(new Error(guidance));
      }
    }

    return bashCallIntent.run({ background }, () =>
      originalExecute(toolCallId, args, signal, onUpdate, ctx),
    );
  };

  return def as unknown as ReturnType<typeof createBashToolDefinition>;
}
