import { homedir } from "os";
import { join } from "path";

/**
 * Resolve ~/.raincode (or $PI_CODING_AGENT_DIR) without importing the full
 * pi-coding-agent SDK. Used on the cold-start path (instrumentation, session
 * list, settings) so the first HTTP request does not pay the SDK module graph.
 *
 * RainCode keeps its own config directory, fully separate from pi's
 * ~/.pi/agent. The SDK resolves its config from $PI_CODING_AGENT_DIR at call
 * time, so process entry points (electron/main.js, daemon/dispatch.mjs,
 * instrumentation.ts) pin that env var to this directory before the SDK loads.
 *
 *   process.env.PI_CODING_AGENT_DIR (tilde-expanded) || join(homedir(), ".raincode")
 */
export function getAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR?.trim();
  if (envDir) return expandTildePath(envDir);
  return join(homedir(), ".raincode");
}

function expandTildePath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}
