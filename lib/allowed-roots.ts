// In-memory roots that should be browsable in addition to roots derived from
// persisted sessions. Stored on globalThis so Next.js hot-reload keeps them.
declare global {
  var __raincodeAllowedRootsCache: { roots: Set<string>; expiresAt: number } | undefined;
  var __raincodeAdditionalAllowedRoots: Set<string> | undefined;
}

import { normalizeSlashes } from "./path-utils";

export { normalizeSlashes };

export function getAdditionalAllowedRoots(): Set<string> {
  if (!globalThis.__raincodeAdditionalAllowedRoots) {
    globalThis.__raincodeAdditionalAllowedRoots = new Set();
  }
  return globalThis.__raincodeAdditionalAllowedRoots;
}

export function allowFileRoot(root: string): void {
  if (!root) return;
  const normalizedRoot = normalizeSlashes(root);
  getAdditionalAllowedRoots().add(normalizedRoot);
  globalThis.__raincodeAllowedRootsCache?.roots.add(normalizedRoot);
}
