/**
 * Ephemeral context messages (memory recall blocks, agent-mode briefs): live
 * only in agent.state.messages so the LLM sees them, but are NEVER persisted
 * to the session file and never accumulate — replacing one prunes the previous.
 *
 * Why not sendCustomMessage({ deliverAs: "nextTurn" }): the SDK persists every
 * queued message on message_end (agent-session.js → appendCustomMessageEntry)
 * and convertToLlm replays custom entries as user messages forever. The agent
 * loop builds context from state.messages (pi-agent-core agent.js), so a plain
 * state push reaches the model without entering the persisted/event stream.
 */

type AgentStateLike = { state?: { messages?: unknown[] } | null };

type MaybeCustom = { role?: string; customType?: string };

function isCustomOf(message: unknown, customTypes: ReadonlySet<string>): boolean {
  const m = message as MaybeCustom | null;
  return m?.role === "custom" && typeof m.customType === "string" && customTypes.has(m.customType);
}

/**
 * Replace the ephemeral block of one customType (content === null → prune only).
 * At most one entry per customType exists in context at any time.
 */
export function setEphemeralContextMessage(agent: AgentStateLike, customType: string, content: string | null): void {
  if (!agent.state) return;
  const drop = new Set([customType]);
  const kept = (agent.state.messages ?? []).filter((m) => !isCustomOf(m, drop));
  if (content) {
    kept.push({ role: "custom", customType, content, display: false, timestamp: Date.now() });
  }
  agent.state.messages = kept;
}

/**
 * Strip ephemeral customTypes from a freshly loaded session's context. Covers
 * sessions written before these blocks became ephemeral (they were persisted
 * by the SDK's nextTurn path); the .jsonl file itself is left untouched.
 */
export function pruneEphemeralContextMessages(agent: AgentStateLike, customTypes: readonly string[]): void {
  if (!agent.state?.messages) return;
  const drop = new Set(customTypes);
  const kept = agent.state.messages.filter((m) => !isCustomOf(m, drop));
  if (kept.length !== agent.state.messages.length) agent.state.messages = kept;
}
