/**
 * Shared invalidation signal for /api/accounts state (GitHub connection).
 *
 * AccountsSettingsPanel and GitPanel both read the same server state; whichever
 * mutates it (device-code login in the Git panel, disconnect in settings) bumps
 * the revision so every mounted reader reloads instead of keeping its
 * mount-time snapshot. No payload cache — readers re-fetch on bump.
 */

type Listener = () => void;

const listeners = new Set<Listener>();
let revision = 0;

export function subscribeAccountsRevision(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getAccountsRevision(): number {
  return revision;
}

export function invalidateAccounts(): void {
  revision += 1;
  for (const listener of listeners) {
    try { listener(); } catch { /* ignore */ }
  }
}
