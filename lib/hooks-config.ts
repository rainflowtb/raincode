/**
 * Hooks config store for RainCode — the single owner of hooks.json file IO.
 *
 * Editable stores:
 *   user:    ~/.raincode/hooks.json
 *   project: <cwd>/.raincode/hooks.json
 * Runtime owner: lib/first-party/hooks-extension (reads fresh on every event,
 * mirroring the MCP pruneStaleServers precedent — no cache, no watcher).
 *
 * Schema/validation live in lib/hooks-schema.ts (client-safe). This module is
 * node-only; routes running on light import it freely (pure fs, no SDK).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getAgentDir } from "./agent-dir";
import {
  parseHooksFile,
  type HookDefinition,
  type HookListItem,
  type HooksFile,
  type HookScope,
} from "./hooks-schema";

export {
  HOOK_EVENTS,
  HOOK_MATCHER_EVENTS,
  HOOK_TIMEOUT_DEFAULT,
  HOOK_TIMEOUT_MAX,
  HOOK_TIMEOUT_MIN,
  hookMatchesTool,
  parseHookDefinition,
  parseHooksFile,
  validateHookPayload,
} from "./hooks-schema";
export type {
  HookDefinition,
  HookEvent,
  HookListItem,
  HookPayloadError,
  HookPayloadOk,
  HooksFile,
  HookScope,
} from "./hooks-schema";

export function getUserHooksPath(): string {
  return join(getAgentDir(), "hooks.json");
}

export function getProjectHooksPath(cwd: string): string {
  return join(cwd, ".raincode", "hooks.json");
}

export function getHooksPathForScope(scope: HookScope, cwd: string | null | undefined): string | null {
  if (scope === "user") return getUserHooksPath();
  return cwd ? getProjectHooksPath(cwd) : null;
}

export function readHooksFile(path: string): HookDefinition[] {
  if (!existsSync(path)) return [];
  try {
    return parseHooksFile(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    // A broken file must not take the agent down; treat as empty.
    return [];
  }
}

/** Read for mutation paths: a file that exists but cannot be parsed must fail
 * the write instead of being silently treated as empty (overwrite = data loss). */
function readHooksFileStrict(path: string): HookDefinition[] {
  if (!existsSync(path)) return [];
  return parseHooksFile(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

function writeHooksFile(path: string, hooks: HookDefinition[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const file: HooksFile = { version: 1, hooks };
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

/** All hooks visible to a project: user scope first, then project scope. */
export function listHooks(cwd: string | null | undefined): HookListItem[] {
  const items: HookListItem[] = [];
  const userPath = getUserHooksPath();
  for (const hook of readHooksFile(userPath)) items.push({ ...hook, scope: "user", sourcePath: userPath });
  if (cwd) {
    const projectPath = getProjectHooksPath(cwd);
    for (const hook of readHooksFile(projectPath)) items.push({ ...hook, scope: "project", sourcePath: projectPath });
  }
  return items;
}

/** Hooks of one scope only (runtime reader). Missing file = empty list. */
export function readScopeHooks(scope: HookScope, cwd: string | null | undefined): HookListItem[] {
  const path = getHooksPathForScope(scope, cwd);
  if (!path) return [];
  return readHooksFile(path).map((hook) => ({ ...hook, scope, sourcePath: path }));
}

/** Insert or replace a hook in its scope's file. Returns the stored definition. */
export function upsertHook(hook: HookDefinition, scope: HookScope, cwd: string | null | undefined): HookDefinition {
  const path = getHooksPathForScope(scope, cwd);
  if (!path) throw Object.assign(new Error("project scope requires cwd"), { status: 400 });
  const hooks = readHooksFileStrict(path);
  const idx = hooks.findIndex((h) => h.id === hook.id);
  if (idx >= 0) hooks[idx] = hook;
  else hooks.push(hook);
  writeHooksFile(path, hooks);
  return hook;
}

export function deleteHook(id: string, scope: HookScope, cwd: string | null | undefined): boolean {
  const path = getHooksPathForScope(scope, cwd);
  if (!path) throw Object.assign(new Error("project scope requires cwd"), { status: 400 });
  const hooks = readHooksFileStrict(path);
  const next = hooks.filter((h) => h.id !== id);
  if (next.length === hooks.length) return false;
  writeHooksFile(path, next);
  return true;
}

export function setHookEnabled(
  id: string,
  enabled: boolean,
  scope: HookScope,
  cwd: string | null | undefined,
): HookDefinition | null {
  const path = getHooksPathForScope(scope, cwd);
  if (!path) throw Object.assign(new Error("project scope requires cwd"), { status: 400 });
  const hooks = readHooksFileStrict(path);
  const hook = hooks.find((h) => h.id === id);
  if (!hook) return null;
  if (enabled) delete hook.enabled;
  else hook.enabled = false;
  writeHooksFile(path, hooks);
  return hook;
}
