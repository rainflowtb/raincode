/**
 * Single owner for "what file content has this runtime shown the agent" plus
 * per-path async locks.
 *
 * read/write/edit record an observation (content hash) for every file they
 * touch. edit refuses to mutate a file that was never observed or whose
 * on-disk content changed since the observation — the only recovery is
 * re-read, so edits based on stale content can never silently land
 * (deepseek-harness read-before-edit / stale-version guard, adapted).
 */
import { createHash } from "crypto";
import { isAbsolute, resolve } from "path";

export type FileObservationState = "fresh" | "stale" | "unobserved";

type Observation = {
  /** sha1 of the LF-normalized content the agent last saw. */
  hash: string;
  recordedAt: number;
};

const observations = new Map<string, Observation>();
const MAX_OBSERVED_PATHS = 500;

/** Per-path serial queue so parallel same-file edits apply in order. */
const pathGates = new Map<string, Promise<void>>();

export function canonicalFilePath(cwd: string, pathValue: string): string {
  return isAbsolute(pathValue) ? pathValue : resolve(cwd, pathValue);
}

export function hashFileText(lfText: string): string {
  return createHash("sha1").update(lfText).digest("hex");
}

/** Record that the agent has seen `absPath` with exactly this LF-normalized content. */
export function recordFileObservation(absPath: string, lfText: string): void {
  if (!absPath) return;
  if (observations.has(absPath)) observations.delete(absPath); // refresh recency
  observations.set(absPath, { hash: hashFileText(lfText), recordedAt: Date.now() });
  while (observations.size > MAX_OBSERVED_PATHS) {
    const oldest = observations.keys().next().value;
    if (oldest === undefined) break;
    observations.delete(oldest);
  }
}

/** Compare current on-disk LF-normalized content against the last observation. */
export function checkFileObservation(absPath: string, currentLfText: string): FileObservationState {
  const seen = observations.get(absPath);
  if (!seen) return "unobserved";
  return seen.hash === hashFileText(currentLfText) ? "fresh" : "stale";
}

/** Test helper — drop all retained observations. */
export function clearFileObservations(): void {
  observations.clear();
}

/**
 * Serialize async work per absolute path. Parallel edit tool calls on the same
 * file become a queue so the second call sees the first write.
 */
export async function withFileLock<T>(
  absPath: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const prev = pathGates.get(absPath) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const chained = prev.then(() => gate);
  pathGates.set(absPath, chained);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (pathGates.get(absPath) === chained) {
      pathGates.delete(absPath);
    }
  }
}

/** Acquire multiple path locks in sorted order (deadlock-safe). */
export async function withFilesLocked<T>(
  absPaths: string[],
  fn: () => Promise<T> | T,
): Promise<T> {
  const unique = [...new Set(absPaths.filter(Boolean))].sort();
  let i = 0;
  const run = async (): Promise<T> => {
    if (i >= unique.length) return await fn();
    const path = unique[i++]!;
    return withFileLock(path, run);
  };
  return run();
}
