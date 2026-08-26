/**
 * mtime+size-keyed cache for small JSON config files read on hot paths.
 *
 * Session-open routes re-read and re-parse the same on-disk catalogs
 * (models.json, models-store.json, provider cache, overrides) on every
 * request; each is a synchronous open+parse on the runtime's event loop.
 * One stat per read is kept so writes invalidate the entry naturally.
 */
import { readFileSync, statSync } from "fs";

type Entry = { mtimeMs: number; size: number; value: unknown };

const cache = new Map<string, Entry>();

/** Parsed JSON, or null when the file is missing or unparseable (also cached). */
export function readJsonFileCached<T>(path: string): T | null {
  let mtimeMs = 0;
  let size = 0;
  try {
    const stat = statSync(path);
    mtimeMs = stat.mtimeMs;
    size = stat.size;
  } catch {
    // Missing / unreadable — cached as a null entry below.
  }
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) {
    return hit.value as T | null;
  }
  let value: T | null = null;
  if (mtimeMs !== 0) {
    try {
      value = JSON.parse(readFileSync(path, "utf8")) as T;
    } catch {
      value = null;
    }
  }
  cache.set(path, { mtimeMs, size, value });
  return value;
}
