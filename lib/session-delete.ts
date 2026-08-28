/**
 * Single owner of "delete a session file forever". Used by the per-session
 * DELETE route and the bulk delete-all-archived route. Cascade-reparents
 * direct children, stops live wrappers, unlinks, and invalidates caches.
 */
import { unlinkSync, promises as fsp } from "fs";
import { join } from "path";
import {
  resolveSessionPath,
  readSessionHeader,
  resolveSessionIdByPath,
  invalidateSessionPathCache,
  invalidateSessionListCache,
} from "./session-reader";
import { getRpcSession } from "./rpc-registry";

export class SessionNotFoundError extends Error {
  constructor(id: string) {
    super(`Session not found: ${id}`);
    this.name = "SessionNotFoundError";
  }
}

/** Permanently delete the session with `id` (or throw SessionNotFoundError). */
export async function deleteSessionById(id: string): Promise<void> {
  const filePath = await resolveSessionPath(id);
  if (!filePath) throw new SessionNotFoundError(id);

  // Read only the bounded header before deleting.
  const parentSessionPath = readSessionHeader(filePath)?.parentSession;

  // Re-attach all direct children to this session's parent (cascade re-parent)
  // Scan sibling files in the same directory. Async + header-probe first so a
  // large session directory doesn't block the event loop reading whole files.
  const dir = filePath.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
  try {
    const files = (await fsp.readdir(dir)).filter((f) => f.endsWith(".jsonl") && join(dir, f) !== filePath);
    for (const file of files) {
      const childPath = join(dir, file);
      try {
        // Cheap probe: the session header is always line 1 — only rewrite
        // files whose header actually points at the deleted session.
        const probe = readSessionHeader(childPath) as { type?: string; parentSession?: string } | null;
        if (!probe || probe.type !== "session" || probe.parentSession !== filePath) continue;
        const content = await fsp.readFile(childPath, "utf8");
        const lines = content.split("\n");
        const header = JSON.parse(lines[0]) as { type?: string; parentSession?: string };
        if (header.type === "session" && header.parentSession === filePath) {
          // Stop a live child wrapper before rewriting its file so we don't
          // race AgentSession appends (which would drop new entries).
          const childId = await resolveSessionIdByPath(childPath);
          if (childId) getRpcSession(childId)?.destroy();
          header.parentSession = parentSessionPath;
          lines[0] = JSON.stringify(header);
          const tmpPath = `${childPath}.reparent.${process.pid}.tmp`;
          await fsp.writeFile(tmpPath, lines.join("\n"));
          await fsp.rename(tmpPath, childPath);
        }
      } catch { /* skip malformed */ }
    }
  } catch { /* skip if dir unreadable */ }

  getRpcSession(id)?.destroy();
  unlinkSync(filePath);
  invalidateSessionPathCache(id);
  invalidateSessionListCache();
}
