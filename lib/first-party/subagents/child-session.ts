/**
 * Create or reopen one in-process child AgentSession for a native subagent.
 */
import {
  createAgentSession,
  DefaultResourceLoader,
  loadProjectContextFiles,
  SessionManager,
  type ExtensionContext,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { basename, dirname, join } from "path";
import { tmpdir } from "os";
import { getAgentDir } from "../../agent-dir";
import { createConfiguredModelRuntime } from "../../model-runtime";
import { createRainCodeCustomTools, extraCustomToolNames } from "../../raincode-custom-tools";
import { SUBAGENT_TOOL_NAMES, type AgentTypeConfig } from "./types";
import { createPermissionInlineExtension } from "../permission";
import { createReportInlineExtension, type ReportDelivery } from "./report";
import { agentModeStripsWriteTools, parseAgentMode } from "../../agent-mode";
import { readGlobalAgentMode } from "../../global-agent-mode";
import {
  MAX_SUBAGENT_DEPTH,
  SUBAGENT_DESCRIPTOR_TYPE,
  type SubagentDescriptor,
} from "./durable";

export type ChildTurnResult = {
  text: string;
  stopReason: "completed" | "aborted" | "error";
  error?: string;
};

export type ChildRun = {
  sessionId: string;
  sessionFile?: string;
  prompt: (text: string) => Promise<ChildTurnResult>;
  steer: (text: string) => Promise<void>;
  interrupt: () => Promise<void>;
  abort: () => Promise<void>;
  dispose: () => void;
  setActivity: (listener: (text?: string) => void) => void;
  getContextUsage: () => { percent?: number | null; tokens?: number | null } | undefined;
  subscribe: (listener: (event: { type?: string; [key: string]: unknown }) => void) => () => void;
  isStreaming: () => boolean;
  streamingMessage: () => unknown;
};

export type CreateChildRunInput = {
  ctx: ExtensionContext;
  type: AgentTypeConfig;
  modelSpec?: string;
  thinkingSpec?: string;
  onReport?: (output: string, delivery: ReportDelivery) => void | Promise<void>;
  sessionFile?: string;
  descriptor?: SubagentDescriptor;
  depth?: number;
};

let sharedRuntime: Promise<ModelRuntime> | null = null;
function childModelRuntime(): Promise<ModelRuntime> {
  if (!sharedRuntime) sharedRuntime = createConfiguredModelRuntime();
  return sharedRuntime;
}

export function childSessionDir(parentFile: string | undefined, cwd: string): string {
  if (parentFile) {
    return join(dirname(parentFile), basename(parentFile, ".jsonl"), "tasks");
  }
  const encoded = cwd.replace(/[/\\]/g, "-").replace(/^[A-Za-z]:-/, "").replace(/^-+/, "");
  return join(tmpdir(), "pi-web-subagents", encoded, "tasks");
}

function collectLastAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: string; content?: unknown };
    if (message.role !== "assistant") continue;
    const content = message.content;
    if (typeof content === "string") {
      const text = content.trim();
      if (text) return text;
      continue;
    }
    if (!Array.isArray(content)) continue;
    const parts: string[] = [];
    for (const block of content) {
      const item = block as { type?: string; text?: string };
      if (item.type === "text" && item.text) parts.push(item.text);
    }
    const text = parts.join("\n\n").trim();
    if (text) return text;
  }
  return "(no output)";
}

/** Fallback agent types carry no maxTurns; cap them so a child cannot loop forever. */
export const DEFAULT_CHILD_MAX_TURNS = 40;

function resolveChildModel(ctx: ExtensionContext, spec?: string) {
  if (!spec) return ctx.model;
  const lower = spec.toLowerCase();
  const slash = spec.indexOf("/");
  if (slash > 0) {
    const found = ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1));
    if (found) return found;
  }
  const candidates = [...ctx.modelRegistry.getAvailable(), ...ctx.modelRegistry.getAll()];
  for (const model of candidates) {
    const ref = `${model.provider}/${model.id}`.toLowerCase();
    if (ref === lower || model.id.toLowerCase() === lower) return model;
  }
  const sample = candidates.slice(0, 10).map((model) => `${model.provider}/${model.id}`).join(", ");
  throw new Error(`Unknown model "${spec}". Use an exact provider/modelId. Available (sample): ${sample}`);
}

function buildSystemPrompt(type: AgentTypeConfig, parentPrompt: string): string {
  if (type.promptMode === "replace") return type.systemPrompt;
  return [parentPrompt.trim(), type.systemPrompt.trim()].filter(Boolean).join("\n\n");
}

/**
 * inject_agents_md is meaningful only in replace mode: append-mode prompts
 * already inherit the parent system prompt, which carries the context files.
 * Best-effort — a broken context file must not prevent the child from spawning.
 */
function buildChildSystemPrompt(type: AgentTypeConfig, parentPrompt: string, cwd: string, agentDir: string): string {
  const base = buildSystemPrompt(type, parentPrompt);
  if (type.injectAgentsMd !== true || type.promptMode !== "replace") return base;
  try {
    const block = loadProjectContextFiles({ cwd, agentDir })
      .map((file) => file.content.trim())
      .filter(Boolean)
      .join("\n\n---\n\n");
    if (!block) return base;
    return `${base}\n\n# Project context (AGENTS.md)\n\n${block}`;
  } catch {
    return base;
  }
}

export async function createChildRun(input: CreateChildRunInput): Promise<ChildRun> {
  const { ctx, type } = input;
  const cwd = ctx.cwd;
  const agentDir = getAgentDir();
  const depth = input.depth ?? 1;
  const canNest = depth < MAX_SUBAGENT_DEPTH;
  const systemPrompt = buildChildSystemPrompt(type, ctx.getSystemPrompt(), cwd, agentDir);
  const mode = parseAgentMode(readGlobalAgentMode());

  const nestedFactory = canNest
    ? (await import("./index")).createSubagentsInlineExtension({ depth: depth + 1 })
    : undefined;

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
    extensionFactories: [
      createPermissionInlineExtension({ uiContext: ctx }),
      ...(input.onReport ? [createReportInlineExtension(input.onReport)] : []),
      ...(nestedFactory ? [nestedFactory] : []),
    ],
  });
  await loader.reload();

  const sessionManager = input.sessionFile
    ? SessionManager.open(input.sessionFile)
    : SessionManager.create(
      cwd,
      childSessionDir(ctx.sessionManager.getSessionFile(), cwd),
      { parentSession: ctx.sessionManager.getSessionId() },
    );

  const customTools = createRainCodeCustomTools({
    cwd,
    getSessionId: () => {
      try { return sessionManager.getSessionId(); } catch { return undefined; }
    },
    getAgentSessionId: () => {
      try { return ctx.sessionManager.getSessionId(); } catch { return undefined; }
    },
  });

  const tools = [...new Set([
    ...type.tools,
    ...extraCustomToolNames(customTools),
    "report",
    ...(canNest ? SUBAGENT_TOOL_NAMES : []),
  ])];
  const active = agentModeStripsWriteTools(mode)
    ? tools.filter((name) => name !== "edit" && name !== "write")
    : tools;

  const modelRuntime = await childModelRuntime();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    sessionManager,
    resourceLoader: loader,
    modelRuntime,
    model: resolveChildModel(ctx, input.modelSpec ?? type.model),
    thinkingLevel: (input.thinkingSpec ?? type.thinking ?? ctx.thinkingLevel) as typeof ctx.thinkingLevel,
    customTools: customTools as never[],
    tools: active,
    excludeTools: canNest ? [] : [...SUBAGENT_TOOL_NAMES],
  });

  if (input.descriptor && !input.sessionFile) {
    try {
      sessionManager.appendCustomEntry(SUBAGENT_DESCRIPTOR_TYPE, input.descriptor);
    } catch {
      // Descriptor is identity metadata; a failed append must not kill the run.
    }
  }

  let activityListener: ((text?: string) => void) | undefined;
  // Per-prompt turn tracking. assistantTurns resets on each prompt() so a
  // continuable child gets a fresh budget per turn, not a cumulative one.
  const maxTurns = type.maxTurns === 0
    ? Number.POSITIVE_INFINITY
    : (type.maxTurns ?? DEFAULT_CHILD_MAX_TURNS);
  let assistantTurns = 0;
  let turnLimitHit = false;
  let lastStopReason: string | undefined;
  let lastErrorMessage: string | undefined;
  const eventListeners = new Set<(event: { type?: string; [key: string]: unknown }) => void>();
  const unsubscribe = session.subscribe((event) => {
    const rec = event as {
      type?: string;
      toolName?: string;
      name?: string;
      args?: unknown;
      message?: { role?: string; stopReason?: string; errorMessage?: string };
    };
    if (rec.type === "tool_execution_start" || rec.type === "tool_call") {
      activityListener?.(activityFromToolEvent(rec));
    }
    if (rec.type === "tool_execution_end" || rec.type === "tool_result") {
      activityListener?.();
    }
    if (rec.type === "message_end" && rec.message?.role === "assistant") {
      activityListener?.();
      lastStopReason = rec.message.stopReason;
      if (rec.message.errorMessage) lastErrorMessage = rec.message.errorMessage;
      assistantTurns += 1;
      if (assistantTurns >= maxTurns) {
        turnLimitHit = true;
        void session.abort();
      }
    }
    for (const listener of eventListeners) listener(event as { type?: string; [key: string]: unknown });
  });

  return {
    sessionId: session.sessionId,
    sessionFile: session.sessionFile,
    async prompt(text): Promise<ChildTurnResult> {
      assistantTurns = 0;
      turnLimitHit = false;
      lastStopReason = undefined;
      lastErrorMessage = undefined;
      let thrown: unknown;
      try {
        if (session.isStreaming) {
          await session.prompt(text, { streamingBehavior: "followUp" });
        } else {
          await session.prompt(text);
        }
      } catch (error) {
        thrown = error;
      }
      const output = collectLastAssistantText(session.messages as unknown[]);
      if (turnLimitHit) {
        return { text: output, stopReason: "error", error: `turn limit reached (${maxTurns})` };
      }
      if (thrown) {
        // abort/interrupt rejects the in-flight prompt; that is not a failure.
        if (lastStopReason === "aborted") return { text: output, stopReason: "aborted" };
        return {
          text: output,
          stopReason: "error",
          error: thrown instanceof Error ? thrown.message : String(thrown),
        };
      }
      if (lastStopReason === "aborted") return { text: output, stopReason: "aborted" };
      if (lastStopReason === "error" || lastStopReason === "length") {
        return {
          text: output,
          stopReason: "error",
          error: lastErrorMessage ?? `child stopped: ${lastStopReason}`,
        };
      }
      return { text: output, stopReason: "completed" };
    },
    async steer(text: string) {
      await session.steer(text);
    },
    async interrupt() {
      if (session.isIdle) return;
      await session.abort();
    },
    async abort() {
      unsubscribe();
      session.dispose();
    },
    dispose() {
      unsubscribe();
      session.dispose();
    },
    setActivity(listener) {
      activityListener = listener;
    },
    getContextUsage() {
      try {
        return (session as { getContextUsage?: () => { percent?: number | null; tokens?: number | null } }).getContextUsage?.();
      } catch {
        return undefined;
      }
    },
    subscribe(listener) {
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },
    isStreaming() {
      return Boolean(session.isStreaming);
    },
    streamingMessage() {
      return (session as { streamingMessage?: unknown }).streamingMessage;
    },
  };
}

function activityFromToolEvent(event: { toolName?: string; name?: string; args?: unknown }): string {
  const name = event.toolName || event.name || "working";
  if (!event.args || typeof event.args !== "object") return name;
  const args = event.args as Record<string, unknown>;
  const hint = [args.path, args.file, args.pattern, args.command, args.query]
    .find((value) => typeof value === "string" && value.trim());
  if (typeof hint !== "string") return name;
  const compact = hint.replace(/\s+/g, " ").trim();
  const clipped = compact.length > 64 ? `${compact.slice(0, 63)}…` : compact;
  return `${name} ${clipped}`;
}
