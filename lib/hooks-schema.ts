/**
 * Hooks data schema — events, types, validation, and tool-matcher semantics.
 * Pure (no node built-ins): safe to import from client components and both
 * runtimes. File IO lives in lib/hooks-config.ts.
 */

/** Lifecycle events a hook can attach to (subset of the SDK extension events). */
export const HOOK_EVENTS = [
  "session_start",
  "before_agent_start",
  "tool_call",
  "tool_result",
  "agent_end",
  "session_before_compact",
  "session_compact",
  "session_shutdown",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Events that support the comma-separated tool-name matcher. */
export const HOOK_MATCHER_EVENTS: readonly HookEvent[] = ["tool_call", "tool_result"];

export type HookScope = "user" | "project";

export type HookDefinition = {
  id: string;
  name: string;
  event: HookEvent;
  /** Shell command. stdin receives a JSON payload; RC_* env vars carry the context. */
  command: string;
  /** tool_call / tool_result only: comma-separated tool names, "*" wildcard, trailing "*" prefix. */
  matcher?: string;
  /** 1–600, default 60. Clamped to 15 for session_shutdown at run time. */
  timeoutSeconds?: number;
  /** Absent/true = enabled. */
  enabled?: boolean;
};

export type HookListItem = HookDefinition & {
  scope: HookScope;
  sourcePath: string;
};

export type HooksFile = {
  version: 1;
  hooks: HookDefinition[];
};

export const HOOK_TIMEOUT_DEFAULT = 60;
export const HOOK_TIMEOUT_MIN = 1;
export const HOOK_TIMEOUT_MAX = 600;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Tolerant parse — unknown fields dropped, invalid entries skipped. */
export function parseHookDefinition(value: unknown): HookDefinition | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" && value.id.trim() ? value.id.trim() : null;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const event = value.event;
  const command = typeof value.command === "string" ? value.command : "";
  if (!id || !name || typeof event !== "string" || !HOOK_EVENTS.includes(event as HookEvent) || !command.trim()) {
    return null;
  }
  const hook: HookDefinition = { id, name, event: event as HookEvent, command };
  if (typeof value.matcher === "string" && value.matcher.trim()) hook.matcher = value.matcher.trim();
  if (typeof value.timeoutSeconds === "number" && Number.isFinite(value.timeoutSeconds)) {
    hook.timeoutSeconds = Math.min(HOOK_TIMEOUT_MAX, Math.max(HOOK_TIMEOUT_MIN, Math.round(value.timeoutSeconds)));
  }
  if (value.enabled === false) hook.enabled = false;
  return hook;
}

export function parseHooksFile(raw: unknown): HookDefinition[] {
  if (!isRecord(raw)) return [];
  const list = raw.hooks;
  if (!Array.isArray(list)) return [];
  const hooks: HookDefinition[] = [];
  for (const item of list) {
    const hook = parseHookDefinition(item);
    if (hook) hooks.push(hook);
  }
  return hooks;
}

export type HookPayloadError = { error: string };
export type HookPayloadOk = { hook: HookDefinition };

/** Validate + normalize a create/update payload (API-side guard, single owner). */
export function validateHookPayload(
  body: Record<string, unknown>,
  existing?: HookDefinition,
): HookPayloadOk | HookPayloadError {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return { error: "name required" };
  if (name.length > 120) return { error: "name too long (max 120)" };
  const event = body.event;
  if (typeof event !== "string" || !HOOK_EVENTS.includes(event as HookEvent)) {
    return { error: `event must be one of: ${HOOK_EVENTS.join(", ")}` };
  }
  const command = typeof body.command === "string" ? body.command.trim() : "";
  if (!command) return { error: "command required" };
  if (command.length > 8000) return { error: "command too long (max 8000)" };
  const matcherRaw = typeof body.matcher === "string" ? body.matcher.trim() : "";
  if (matcherRaw.length > 500) return { error: "matcher too long (max 500)" };
  let timeoutSeconds: number | undefined;
  if (typeof body.timeoutSeconds === "number" && Number.isFinite(body.timeoutSeconds)) {
    timeoutSeconds = Math.min(HOOK_TIMEOUT_MAX, Math.max(HOOK_TIMEOUT_MIN, Math.round(body.timeoutSeconds)));
  }
  const hook: HookDefinition = {
    id: existing?.id ?? (typeof body.id === "string" && body.id.trim() ? body.id.trim() : cryptoRandomId()),
    name,
    event: event as HookEvent,
    command,
  };
  const effectiveMatcher = HOOK_MATCHER_EVENTS.includes(hook.event) ? matcherRaw : "";
  if (effectiveMatcher) hook.matcher = effectiveMatcher;
  if (timeoutSeconds !== undefined && timeoutSeconds !== HOOK_TIMEOUT_DEFAULT) hook.timeoutSeconds = timeoutSeconds;
  if (body.enabled === false) hook.enabled = false;
  return { hook };
}

function cryptoRandomId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    // Non-secure contexts in older browsers; uuid is not security-critical here.
    return `h-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * Matcher for tool events: comma-separated tokens; empty or "*" matches all;
 * a trailing "*" is a prefix match; otherwise exact (case-insensitive).
 */
export function hookMatchesTool(hook: HookDefinition, toolName: string): boolean {
  if (!hook.matcher || !hook.matcher.trim()) return true;
  const name = toolName.toLowerCase();
  for (const rawToken of hook.matcher.split(",")) {
    const token = rawToken.trim().toLowerCase();
    if (!token || token === "*") return true;
    if (token.endsWith("*")) {
      if (name.startsWith(token.slice(0, -1))) return true;
    } else if (name === token) {
      return true;
    }
  }
  return false;
}
