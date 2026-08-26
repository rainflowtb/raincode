/**
 * Per-parent subagent record store: first-wins settlement, reported-claim,
 * concurrency capping + queue pump, and a per-child promise-chain lock.
 * The single owner of subagent record state transitions.
 */
import { randomUUID } from "crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readWebSettings } from "../../web-settings";
import type { ChildRun } from "./child-session";
import type { SubagentMode } from "./durable";
import type { AgentTypeConfig, SubagentRecord, SubagentStatus } from "./types";

export function maxConcurrent(): number {
  const cap = readWebSettings().subagentConcurrency;
  if (!cap.enabled) return Number.MAX_SAFE_INTEGER;
  return Math.max(1, Math.min(16, cap.max));
}

export type LiveRecord = SubagentRecord & {
  run?: ChildRun;
  /** Promise chain serializing prompt turns on this child (harness ChildLock). */
  lock: Promise<unknown>;
  waiters: Array<(record: SubagentRecord) => void>;
  publishedWaiters: Array<(record: SubagentRecord) => void>;
  queuedPrompt?: string;
  typeConfig: AgentTypeConfig;
  ctx: ExtensionContext;
  modelSpec?: string;
  thinkingSpec?: string;
  /** Wall-clock ms of the parent turn that spawned/resumed this agent. */
  parentTurnStartedAt: number;
  /** The parent already received this turn's result inline (foreground wait / get_subagent_result). */
  collected: boolean;
  /** A completion notice for this turn's result was sent or claimed — at most once. */
  reported: boolean;
  /** Spawned with run_in_background — eligible for idle-parent wake on settle. */
  background: boolean;
  mode: SubagentMode;
  depth: number;
  seed?: string;
};

export type CreateRecordInput = {
  ctx: ExtensionContext;
  type: AgentTypeConfig;
  description: string;
  note?: string;
  modelSpec?: string;
  thinkingSpec?: string;
  background: boolean;
  mode: SubagentMode;
  depth: number;
  seed?: string;
  queuedPrompt?: string;
  parentTurnStartedAt: number;
  /** Fixed id + completed/collected state for disk-hydrated records. */
  hydrated?: { id: string; sessionId: string; sessionFile?: string; startedAt: number };
};

export type RegistryHooks = {
  onChange: () => void;
  /** Fired exactly once per turn settlement (first-wins), after waiters run. */
  onSettle: (record: LiveRecord) => void;
  /** Start a queued record once capacity frees up. */
  startQueued: (record: LiveRecord, prompt: string) => void;
  /** Concurrency cap override (tests); defaults to the subagentConcurrency setting. */
  maxConcurrent?: () => number;
};

/** Terminal-for-good statuses: the record can never run again. */
export function isHardStop(status: SubagentStatus): boolean {
  return status === "stopped" || status === "aborted";
}

/** The current turn is over (the record may still be resumed later). */
export function isTurnDone(status: SubagentStatus): boolean {
  return status === "completed" || status === "error" || isHardStop(status);
}

export class SubagentRegistry {
  private readonly records = new Map<string, LiveRecord>();
  private readonly cap: () => number;

  constructor(private readonly hooks: RegistryHooks) {
    this.cap = hooks.maxConcurrent ?? maxConcurrent;
  }

  create(input: CreateRecordInput): LiveRecord {
    const hydrated = input.hydrated;
    const atCapacity = !hydrated && this.runningCount() >= this.cap();
    const record: LiveRecord = {
      id: hydrated?.id ?? randomUUID(),
      type: input.type.name,
      displayName: input.type.displayName,
      description: input.description,
      status: hydrated ? "completed" : atCapacity ? "queued" : "running",
      startedAt: hydrated?.startedAt ?? Date.now(),
      note: input.note,
      lock: Promise.resolve(),
      waiters: [],
      publishedWaiters: [],
      queuedPrompt: atCapacity ? input.queuedPrompt : undefined,
      typeConfig: input.type,
      ctx: input.ctx,
      modelSpec: input.modelSpec,
      thinkingSpec: input.thinkingSpec,
      parentTurnStartedAt: input.parentTurnStartedAt,
      collected: Boolean(hydrated),
      reported: Boolean(hydrated),
      background: input.background,
      mode: input.mode,
      depth: input.depth,
      seed: input.seed,
      sessionId: hydrated?.sessionId,
      sessionFile: hydrated?.sessionFile,
    };
    this.records.set(record.id, record);
    this.hooks.onChange();
    return record;
  }

  resolve(id: string): LiveRecord | undefined {
    return this.records.get(id)
      ?? [...this.records.values()].find((record) => record.sessionId === id);
  }

  get(id: string): SubagentRecord | undefined {
    const record = this.resolve(id);
    return record ? publicRecord(record) : undefined;
  }

  list(): SubagentRecord[] {
    return [...this.records.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map(publicRecord);
  }

  all(): LiveRecord[] {
    return [...this.records.values()];
  }

  runningCount(): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.status === "running") count += 1;
    }
    return count;
  }

  /** Open a new turn on the record: running, fresh result slot, needs delivery again. */
  beginTurn(record: LiveRecord): void {
    if (isHardStop(record.status)) {
      throw new Error(`Agent "${record.id}" cannot run (status: ${record.status}).`);
    }
    record.status = "running";
    record.result = undefined;
    record.error = undefined;
    record.startedAt = Date.now();
    record.completedAt = undefined;
    record.collected = false;
    record.reported = false;
    this.hooks.onChange();
  }

  /**
   * First-wins settlement: only a live (running/queued) record can settle.
   * Every state flip notifies waiters, pumps the queue, and fires onSettle —
   * there is no path that leaves waiters hanging or the queue starved.
   */
  settle(
    record: LiveRecord,
    status: SubagentStatus,
    result?: string,
    error?: string,
  ): boolean {
    if (record.status !== "running" && record.status !== "queued") return false;
    record.status = status;
    record.result = result;
    record.error = error;
    record.completedAt = Date.now();
    snapshotUsage(record);
    const snapshot = publicRecord(record);
    for (const waiter of record.waiters.splice(0)) waiter(snapshot);
    this.flushPublished(record);
    this.hooks.onSettle(record);
    this.hooks.onChange();
    this.pump();
    return true;
  }

  /** Serialize prompt turns per child: concurrent follow-up/deliver calls queue up. */
  withLock<T>(record: LiveRecord, fn: () => Promise<T>): Promise<T> {
    const run = record.lock.then(fn, fn);
    record.lock = run.catch(() => {});
    return run;
  }

  /** Claim the completion notice for this turn's result. False = already claimed. */
  claimReport(record: LiveRecord): boolean {
    if (record.collected || record.reported || !isTurnDone(record.status)) return false;
    record.reported = true;
    record.collected = true;
    return true;
  }

  markCollected(id: string): void {
    const record = this.resolve(id);
    if (!record || !isTurnDone(record.status)) return;
    record.collected = true;
    record.reported = true;
  }

  /** Finished turns whose result never reached the parent. */
  finishedUndelivered(): LiveRecord[] {
    return [...this.records.values()].filter(
      (record) => isTurnDone(record.status) && !record.collected && !record.reported,
    );
  }

  flushPublished(record: LiveRecord): void {
    if (record.publishedWaiters.length === 0) return;
    const snapshot = publicRecord(record);
    for (const waiter of record.publishedWaiters.splice(0)) waiter(snapshot);
  }

  private pump(): void {
    if (this.runningCount() >= this.cap()) return;
    for (const record of this.records.values()) {
      if (record.status !== "queued" || !record.queuedPrompt) continue;
      const prompt = record.queuedPrompt;
      record.queuedPrompt = undefined;
      this.hooks.startQueued(record, prompt);
      return;
    }
  }
}

export function publicRecord(record: LiveRecord): SubagentRecord {
  return {
    id: record.id,
    type: record.type,
    displayName: record.displayName,
    description: record.description,
    status: record.status,
    result: record.result,
    error: record.error,
    activity: record.activity,
    contextPercent: record.contextPercent,
    contextTokens: record.contextTokens,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    note: record.note,
    sessionId: record.sessionId,
    sessionFile: record.sessionFile,
    mode: record.mode,
    depth: record.depth,
    summary: record.typeConfig.description,
    parentTurnStartedAt: record.parentTurnStartedAt,
  };
}

export function snapshotUsage(record: LiveRecord): void {
  const usage = record.run?.getContextUsage();
  const percent = usage?.percent;
  if (typeof percent === "number" && Number.isFinite(percent)) {
    record.contextPercent = Math.max(0, Math.min(100, percent));
  }
  const tokens = usage?.tokens;
  if (typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0) {
    record.contextTokens = tokens;
  }
}
