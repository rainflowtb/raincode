/**
 * Generic background-result delivery — the single path by which async results
 * (subagent finishes, background job exits) reach the session. The current
 * turn NEVER blocks on them:
 *   busy  → finished results are collected at the next agent_end;
 *   idle  → a budgeted wake (followUp + triggerTurn) opens a turn;
 *   gone  → the notice is dropped.
 * Every result is reported at most once (records.claimReport).
 */
export const MAX_CONSECUTIVE_WAKES = 3;

export type DeliveryRecords<T extends { id: string }> = {
  finishedUndelivered(): T[];
  claimReport(id: string): boolean;
};

export type DeliverySink = {
  isParentIdle(): boolean;
  /** followUp + triggerTurn — opens a parent turn. */
  wakeParent(message: string): void;
};

export class TurnDelivery<T extends { id: string }> {
  private consecutiveWakes = 0;

  constructor(
    protected readonly records: DeliveryRecords<T>,
    protected readonly sink: DeliverySink,
    /** Renders a batch of claimed records into one parent-visible message. */
    private readonly formatBatch: (records: T[]) => string,
  ) {}

  /** User-authored input refills the wake budget. */
  resetWakeBudget(): void {
    this.consecutiveWakes = 0;
  }

  /** Non-blocking collect of everything already finished; null when nothing. */
  collect(): string | null {
    const claimed = this.records.finishedUndelivered()
      .filter((record) => this.records.claimReport(record.id));
    if (claimed.length === 0) return null;
    return this.formatBatch(claimed);
  }

  /**
   * Settle hook: wake an idle parent (within budget) so background results
   * arrive without user input. Busy parents collect at agent_end instead.
   */
  notifySettled(record: T): void {
    if (!this.sink.isParentIdle()) return;
    if (this.consecutiveWakes >= MAX_CONSECUTIVE_WAKES) return;
    if (!this.records.claimReport(record.id)) return;
    this.consecutiveWakes += 1;
    this.sink.wakeParent(this.formatBatch([record]));
  }
}
