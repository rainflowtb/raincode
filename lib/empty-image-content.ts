/**
 * Empty-image scrub: a failed capture (e.g. a detached browser view) once
 * wrote {type:"image", data:""} blocks into session files; replayed to the
 * provider they hard-fail every subsequent request (GLM: 400 code 1214).
 * Replaces them with a text note in the freshly loaded in-memory context.
 * The .jsonl file itself is left untouched.
 */

type AgentStateLike = { state?: { messages?: unknown[] } | null };

export const EMPTY_IMAGE_NOTE = "[image omitted: empty capture]";

/** Returns the number of blocks scrubbed. */
export function scrubEmptyImageBlocks(agent: AgentStateLike): number {
  const messages = agent.state?.messages;
  if (!Array.isArray(messages)) return 0;
  let scrubbed = 0;
  for (const message of messages) {
    const content = (message as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) continue;
    for (let i = 0; i < content.length; i++) {
      const block = content[i] as { type?: string; data?: unknown } | null;
      if (block?.type === "image" && (typeof block.data !== "string" || block.data.length === 0)) {
        content[i] = { type: "text", text: EMPTY_IMAGE_NOTE };
        scrubbed++;
      }
    }
  }
  return scrubbed;
}
