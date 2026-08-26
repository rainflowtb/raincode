/**
 * Spawn, continue, interrupt, and tear down native subagents for one parent.
 * Record state transitions live in registry.ts (first-wins settle + queue);
 * result delivery lives in delivery.ts. A finished turn keeps the child
 * session resident; only kill / teardown / one-shot settle dispose it.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cacheSessionPath } from "../../session-reader";
import { registerChildRun, unregisterChildRun } from "./host";
import { createChildRun, type ChildTurnResult } from "./child-session";
import { listDiskChildren, type SubagentDescriptor, type SubagentMode } from "./durable";
import { loadAgentTypes, resolveAgentType } from "./catalog";
import {
  isHardStop,
  isTurnDone,
  publicRecord,
  snapshotUsage,
  SubagentRegistry,
  type LiveRecord,
} from "./registry";
import type { AgentTypeConfig, SubagentRecord } from "./types";
import type { ReportDelivery } from "./report";

export class NativeSubagentManager {
  private readonly registry: SubagentRegistry;
  private onChange: (() => void) | null = null;
  private onPublish: ((record: SubagentRecord) => void) | null = null;
  private onReport: ((record: SubagentRecord, output: string, delivery: ReportDelivery) => void) | null = null;
  private onSettle: ((record: SubagentRecord) => void) | null = null;
  private tornDown = false;
  private currentTurnStartedAt = 0;

  /** @param depth depth of children this manager spawns (1 for root sessions). */
  constructor(private readonly depth: number = 1) {
    this.registry = new SubagentRegistry({
      onChange: () => this.emit(),
      onSettle: (record) => this.handleSettled(record),
      startQueued: (record, prompt) => this.start(record, prompt),
    });
  }

  /** Wall-clock ms of the current parent turn's start (idle-input beginPrompt). 0 until a turn begins. */
  get currentTurnStartMs(): number {
    return this.currentTurnStartedAt;
  }

  beginPrompt(): void {
    this.currentTurnStartedAt = Date.now();
    this.emit();
  }

  setOnChange(handler: () => void): void {
    this.onChange = handler;
  }

  setOnPublish(handler: (record: SubagentRecord) => void): void {
    this.onPublish = handler;
  }

  setOnReport(handler: (record: SubagentRecord, output: string, delivery: ReportDelivery) => void): void {
    this.onReport = handler;
  }

  /** Completion-notice hook (delivery.ts). Fires once per settled turn. */
  setOnSettle(handler: (record: SubagentRecord) => void): void {
    this.onSettle = handler;
  }

  list(): SubagentRecord[] {
    return this.registry.list();
  }

  get(id: string): SubagentRecord | undefined {
    return this.registry.get(id);
  }

  markCollected(id: string): void {
    this.registry.markCollected(id);
  }

  /** delivery.ts feed: finished turns whose result never reached the parent. */
  finishedUndelivered(): SubagentRecord[] {
    return this.registry.finishedUndelivered().map(publicRecord);
  }

  /** delivery.ts claim: at-most-once completion notice. */
  claimReport(id: string): boolean {
    const record = this.registry.resolve(id);
    return record ? this.registry.claimReport(record) : false;
  }

  isResident(id: string): boolean {
    return Boolean(this.registry.resolve(id)?.run);
  }

  hydrate(ctx: ExtensionContext): void {
    const parentFile = ctx.sessionManager.getSessionFile();
    const types = loadAgentTypes(ctx.cwd);
    for (const disk of listDiskChildren(parentFile)) {
      if (disk.descriptor?.mode === "one-shot") continue;
      if (this.registry.all().some((record) => record.sessionId === disk.sessionId)) continue;
      const resolved = resolveAgentType(disk.descriptor?.type, types);
      this.registry.create({
        ctx,
        type: resolved.type,
        description: disk.descriptor?.label || resolved.type.displayName,
        background: false,
        mode: "continuable",
        // Depth budget is durable and monotone: a resumed child can never
        // re-enter with less depth than this manager's factory implies.
        depth: Math.max(disk.descriptor?.depth ?? 1, this.depth),
        parentTurnStartedAt: disk.descriptor?.parentTurnStartedAt ?? 0,
        hydrated: {
          id: disk.descriptor?.agentId || disk.sessionId,
          sessionId: disk.sessionId,
          sessionFile: disk.sessionFile,
          startedAt: Date.parse(disk.createdAt) || Date.now(),
        },
      });
    }
    this.emit();
  }

  spawn(input: {
    ctx: ExtensionContext;
    type: AgentTypeConfig;
    prompt: string;
    description: string;
    note?: string;
    modelSpec?: string;
    thinkingSpec?: string;
    background: boolean;
    mode?: SubagentMode;
    seed?: string;
  }): { id: string } {
    const record = this.registry.create({
      ctx: input.ctx,
      type: input.type,
      description: input.description,
      note: input.note,
      modelSpec: input.modelSpec,
      thinkingSpec: input.thinkingSpec,
      background: input.background,
      mode: input.mode ?? "continuable",
      depth: this.depth,
      seed: input.seed,
      queuedPrompt: input.prompt,
      parentTurnStartedAt: this.currentTurnStartedAt,
    });
    if (record.status === "running") this.start(record, input.prompt);
    return { id: record.id };
  }

  async waitPublished(id: string, signal?: AbortSignal): Promise<SubagentRecord> {
    const record = this.requireRecord(id);
    if (record.sessionId || isHardStop(record.status)) return publicRecord(record);
    return new Promise((resolve) => {
      const onAbort = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve(publicRecord(record));
      };
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
          return;
        }
      }
      record.publishedWaiters.push(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve(publicRecord(record));
      });
    });
  }

  async wait(id: string, signal?: AbortSignal): Promise<SubagentRecord> {
    const record = this.requireRecord(id);
    if (isTurnDone(record.status)) return publicRecord(record);
    return new Promise((resolve) => {
      const onAbort = () => {
        signal?.removeEventListener("abort", onAbort);
        // Foreground wait aborted: one-shot children are killed; continuable
        // children keep residency — only their current turn is interrupted.
        if (record.mode === "one-shot") void this.kill(record.id);
        else void this.interrupt(record.id);
        resolve(publicRecord(record));
      };
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
          return;
        }
      }
      record.waiters.push((snapshot) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(snapshot);
      });
    });
  }

  /**
   * Queue a continuation without waiting for the child turn.
   * send_message uses this; resume / human follow-up still wait via followup().
   */
  async deliver(id: string, message: string): Promise<SubagentRecord> {
    const record = this.prepareContinuation(id);
    const turn = this.continueTurn(record, message);
    void turn.catch((error: unknown) => {
      this.registry.settle(
        record,
        "error",
        undefined,
        error instanceof Error ? error.message : String(error),
      );
    });
    return publicRecord(record);
  }

  async followup(id: string, message: string, signal?: AbortSignal): Promise<SubagentRecord> {
    const record = this.prepareContinuation(id);
    try {
      await this.continueTurn(record, message);
    } catch (error) {
      this.registry.settle(
        record,
        "error",
        undefined,
        error instanceof Error ? error.message : String(error),
      );
    }
    if (signal?.aborted && record.status === "running") {
      await this.interrupt(record.id);
    }
    return publicRecord(record);
  }

  async steer(id: string, message: string): Promise<string> {
    const record = this.registry.resolve(id);
    if (!record) return `Agent not found: "${id}".`;
    if (record.status !== "running" || !record.run) {
      return `Agent "${id}" is not running (status: ${record.status}). Cannot steer.`;
    }
    await record.run.steer(message);
    return `Steering message delivered to ${id}.`;
  }

  /** Stop the current turn only; the child stays resident for follow-up. */
  async interrupt(id: string): Promise<string> {
    const record = this.registry.resolve(id);
    if (!record) return `Agent not found: "${id}".`;
    if (record.status === "queued") {
      this.registry.settle(record, "stopped", undefined, "Stopped before start.");
      return `Agent ${id} stopped before start.`;
    }
    if (record.status !== "running" || !record.run) {
      return `Agent "${id}" is not running (status: ${record.status}).`;
    }
    await record.run.interrupt();
    return `Interrupt requested for ${id}. The child stays available for follow-up.`;
  }

  /** Parent Stop: interrupt in-flight child turns; resident children survive. */
  async interruptAll(): Promise<void> {
    await Promise.all(
      this.registry.all()
        .filter((record) => record.status === "running" && record.run)
        .map((record) => record.run!.interrupt().catch(() => {})),
    );
  }

  /** Hard stop: dispose the child session. The record can never run again. */
  async kill(id: string): Promise<boolean> {
    const record = this.registry.resolve(id);
    if (!record) return false;
    this.disposeRun(record);
    this.registry.settle(record, "stopped", undefined, "Killed.");
    return true;
  }

  /** Session teardown: dispose every child, settle live records so waiters exit. */
  teardown(): void {
    if (this.tornDown) return;
    this.tornDown = true;
    for (const record of this.registry.all()) {
      this.disposeRun(record);
      if (!isTurnDone(record.status)) {
        this.registry.settle(record, "stopped", undefined, "Session torn down.");
      }
    }
  }

  private requireRecord(id: string): LiveRecord {
    const record = this.registry.resolve(id);
    if (!record) throw new Error(`Agent not found: "${id}"`);
    return record;
  }

  private prepareContinuation(id: string): LiveRecord {
    const record = this.requireRecord(id);
    if (record.mode === "one-shot") {
      throw new Error(`Agent "${id}" is one-shot and cannot be continued.`);
    }
    record.parentTurnStartedAt = this.currentTurnStartedAt;
    return record;
  }

  /** Serialized per-child prompt turn; errors settle as "error", never throw past the lock. */
  private continueTurn(record: LiveRecord, message: string): Promise<void> {
    return this.registry.withLock(record, async () => {
      await this.ensureRun(record);
      if (!record.run || isHardStop(record.status)) {
        throw new Error(`Agent "${record.id}" cannot be continued (status: ${record.status}).`);
      }
      this.registry.beginTurn(record);
      const outcome = await record.run.prompt(message);
      this.settleOutcome(record, outcome);
    });
  }

  private settleOutcome(record: LiveRecord, outcome: ChildTurnResult): void {
    if (outcome.stopReason === "error") {
      this.registry.settle(record, "error", outcome.text, outcome.error ?? "child failed");
      return;
    }
    // "aborted" here means interrupt/parent-Stop ended the turn — the child
    // stays resident, so the turn completes with whatever text landed.
    this.registry.settle(record, "completed", outcome.text);
  }

  private handleSettled(record: LiveRecord): void {
    snapshotUsage(record);
    if (record.mode === "one-shot") this.disposeRun(record);
    // Only background work wakes the parent; foreground results return inline.
    if (!this.tornDown && record.background) this.onSettle?.(publicRecord(record));
  }

  private disposeRun(record: LiveRecord): void {
    if (!record.run) return;
    try { record.run.dispose(); } catch { /* already gone */ }
    record.run = undefined;
  }

  private descriptorFor(record: LiveRecord): SubagentDescriptor {
    return {
      version: 1,
      mode: record.mode,
      agentId: record.id,
      type: record.type,
      label: record.description,
      depth: record.depth,
      parentTurnStartedAt: record.parentTurnStartedAt,
    };
  }

  private async ensureRun(record: LiveRecord): Promise<void> {
    if (record.run) return;
    const run = await createChildRun({
      ctx: record.ctx,
      type: record.typeConfig,
      modelSpec: record.modelSpec,
      thinkingSpec: record.thinkingSpec,
      onReport: (output, delivery) => this.onReport?.(publicRecord(record), output, delivery),
      sessionFile: record.sessionFile,
      descriptor: record.sessionFile ? undefined : this.descriptorFor(record),
      depth: record.depth,
    });
    if (isHardStop(record.status) || this.tornDown) {
      try { run.dispose(); } catch { /* already gone */ }
      return;
    }
    record.run = run;
    record.sessionId = run.sessionId;
    record.sessionFile = run.sessionFile;
    if (run.sessionId && run.sessionFile) cacheSessionPath(run.sessionId, run.sessionFile);
    const parentId = record.ctx.sessionManager.getSessionId();
    if (parentId && run.sessionId) registerChildRun(parentId, run);
    const dispose = run.dispose.bind(run);
    run.dispose = () => {
      unregisterChildRun(run.sessionId, run);
      dispose();
    };
    run.setActivity((text) => {
      if (text) record.activity = text;
      snapshotUsage(record);
      this.emit();
    });
    snapshotUsage(record);
    this.registry.flushPublished(record);
    this.onPublish?.(publicRecord(record));
    this.emit();
  }

  private start(record: LiveRecord, prompt: string): void {
    const turn = this.registry.withLock(record, async () => {
      if (isTurnDone(record.status) && record.status !== "queued") return;
      if (isHardStop(record.status)) return;
      this.registry.beginTurn(record);
      try {
        await this.ensureRun(record);
        if (!record.run) return; // hard-stopped or torn down mid-ensure
        const text = record.seed ? `${record.seed}\n\n${prompt}` : prompt;
        record.seed = undefined;
        const outcome = await record.run.prompt(text);
        this.settleOutcome(record, outcome);
      } catch (error) {
        this.registry.settle(
          record,
          "error",
          undefined,
          error instanceof Error ? error.message : String(error),
        );
      }
    });
    void turn.catch(() => {});
  }

  private emit(): void {
    this.onChange?.();
  }
}
