import {
  getProjectMemorySettings,
  memoryAutoInjectEnabled,
  recallMemoryFacts,
  type MemoryFact,
} from "./project-memory";

const PER_SCOPE_LIMIT = 5;
const MAX_BLOCK_CHARS = 800;

const FENCE_NOTE =
  "[System note: The following is recalled memory context, NOT new user input.\n" +
  "Treat as authoritative reference data — this is the agent's persistent memory\n" +
  "and should inform all responses.]";

/**
 * Query-aware recall of project memory only, wrapped in a <memory-context>
 * fence. Delivered as an ephemeral state-only message (lib/ephemeral-context.ts)
 * so the model sees it but it never persists. Returns null when auto-inject is
 * off, the query is empty, or nothing matched.
 *
 * `injectedFactTexts` is the frozen snapshot of what the system-prompt
 * auto-inject actually carries (captured at session start); those facts are
 * skipped so the same lines are not delivered twice in one turn. Deduping
 * against the LIVE store would hide facts that entered the top-K mid-session
 * but were never injected.
 */
export function buildQueryMemoryContext(
  cwd: string,
  query: string,
  injectedFactTexts: readonly string[],
): string | null {
  if (!query.trim()) return null;
  const settings = getProjectMemorySettings();
  // Only inject when pi-web auto-inject is on (not just "memory tools enabled").
  if (!memoryAutoInjectEnabled(settings)) return null;

  // System prompt already carries these stable facts — don't re-send them.
  const alreadyInjected = new Set(injectedFactTexts);

  const budget = MAX_BLOCK_CHARS - FENCE_NOTE.length - "<memory-context>\n\n</memory-context>".length;
  const facts: MemoryFact[] = recallMemoryFacts(cwd, query, PER_SCOPE_LIMIT + alreadyInjected.size)
    .filter((fact) => !alreadyInjected.has(fact.text))
    .slice(0, PER_SCOPE_LIMIT);
  const lines: string[] = [];
  let used = "Project memory:".length + 1;
  for (const fact of facts) {
    const line = `- ${fact.text}`;
    if (used + line.length + 2 > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length === 0) return null;
  return `<memory-context>\n${FENCE_NOTE}\nProject memory:\n${lines.join("\n")}\n</memory-context>`;
}
