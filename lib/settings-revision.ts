/**
 * File-watch revision broadcaster for cross-client settings invalidation.
 *
 * raincode.json and the permission policy have several independent writers —
 * this renderer, LAN clients (PUT /api/web-settings), and heavy-side mode sync
 * (persistGlobalAgentMode from set_mode) — possibly in another process. The
 * light/heavy split makes per-writer cache notification impossible, so the
 * light runtime watches the two files instead and fans one `changed` event out
 * to every connected renderer over SSE (/api/web-settings/events). Clients
 * revalidate on the event; there is no polling. Watching the directory (not
 * the file) because the policy is written via atomic rename.
 */
import { watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { getWebSettingsPath } from "./web-settings";
import { getPermissionPolicyPath } from "./permission-policy";

type Listener = () => void;

const listeners = new Set<Listener>();
let revision = 0;
let watcher: FSWatcher | null = null;
let debounce: ReturnType<typeof setTimeout> | null = null;

export function getSettingsRevision(): number {
  return revision;
}

function bump(): void {
  revision += 1;
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* ignore */ }
  }
}

/** Process-lifetime watcher; a transient fs error drops it so the next subscriber re-arms it. */
function ensureWatcher(): void {
  if (watcher) return;
  const settingsPath = getWebSettingsPath();
  const watchedFiles = new Set([basename(settingsPath), basename(getPermissionPolicyPath())]);
  try {
    watcher = watch(dirname(settingsPath), (_event, filename) => {
      if (!filename || !watchedFiles.has(basename(String(filename)))) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        bump();
      }, 100);
      debounce.unref?.();
    });
    watcher.on("error", () => {
      try { watcher?.close(); } catch { /* ignore */ }
      watcher = null;
    });
  } catch {
    watcher = null;
  }
}

/** Subscribe to settings/policy file changes; returns the unsubscribe function. */
export function subscribeSettingsRevision(listener: Listener): () => void {
  ensureWatcher();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
