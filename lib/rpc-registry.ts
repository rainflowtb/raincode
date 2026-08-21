/**
 * In-process session registry (globalThis for Next hot-reload survival).
 * Single Map owner — do not add a parallel registry.
 */

import { realpathSync } from "fs";
import { resolve } from "path";
import type { AgentSessionWrapper } from "./rpc-session-wrapper";

declare global {
  var __raincodeSessions: Map<string, AgentSessionWrapper> | undefined;
  var __raincodeStartLocks: Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> | undefined;
  var __raincodeStartingSessionCwds: Map<string, number> | undefined;
}

export function getRegistry(): Map<string, AgentSessionWrapper> {
  if (!globalThis.__raincodeSessions) {
    globalThis.__raincodeSessions = new Map();
    const cleanup = () => globalThis.__raincodeSessions?.forEach((s) => s.destroy());
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  return globalThis.__raincodeSessions;
}

export function getLocks(): Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> {
  if (!globalThis.__raincodeStartLocks) globalThis.__raincodeStartLocks = new Map();
  return globalThis.__raincodeStartLocks;
}

export function getRpcSession(sessionId: string): AgentSessionWrapper | undefined {
  return getRegistry().get(sessionId);
}

function normalizeRpcCwd(cwd: string): string {
  try {
    return realpathSync(resolve(cwd));
  } catch {
    return resolve(cwd);
  }
}

export function getStartingSessionCwds(): Map<string, number> {
  if (!globalThis.__raincodeStartingSessionCwds) globalThis.__raincodeStartingSessionCwds = new Map();
  return globalThis.__raincodeStartingSessionCwds;
}

export function hasBusyRpcSessionForCwd(cwd: string): boolean {
  const targetCwd = normalizeRpcCwd(cwd);
  if (getStartingSessionCwds().has(targetCwd)) return true;
  return Array.from(getRegistry().values()).some(
    (session) => normalizeRpcCwd(session.cwd) === targetCwd && session.isRunning(),
  );
}

export async function destroyRpcSessionsForCwd(cwd: string): Promise<number> {
  const targetCwd = normalizeRpcCwd(cwd);
  const sessions = Array.from(getRegistry().values()).filter(
    (session) => normalizeRpcCwd(session.cwd) === targetCwd,
  );
  await Promise.all(sessions.map((session) => session.shutdown()));
  return sessions.length;
}

/**
 * Shut down idle (not streaming) in-process sessions so the next prompt
 * reloads system prompt extras (e.g. Lean Mode policy). Running sessions
 * are left alone so we do not kill an active turn.
 */
export async function destroyIdleRpcSessions(): Promise<number> {
  const sessions = Array.from(getRegistry().values()).filter((session) => !session.isRunning());
  await Promise.all(sessions.map((session) => session.shutdown()));
  return sessions.length;
}

export { normalizeRpcCwd };
