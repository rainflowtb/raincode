/**
 * Result delivery — the single path by which child results reach the parent.
 * The parent turn NEVER blocks on a background child:
 *   busy parent  → finished results are collected at the next agent_end;
 *   idle parent  → a budgeted wake (followUp + triggerTurn) opens a turn;
 *   gone parent  → the notice is dropped.
 * Every result is reported at most once (registry claimReport).
 */
import { SUBAGENT_RESULTS_CUSTOM_TYPE } from "../../types";
import {
  TurnDelivery,
  MAX_CONSECUTIVE_WAKES,
  type DeliveryRecords,
  type DeliverySink,
} from "../turn-delivery";
import type { SubagentRecord } from "./types";

export { SUBAGENT_RESULTS_CUSTOM_TYPE, MAX_CONSECUTIVE_WAKES };
export type { DeliveryRecords, DeliverySink };

const SKIP_STOP_REASONS = new Set(["aborted", "error", "length"]);

/** Caps keep a runaway child result from flooding the parent context. */
export const RESULT_CAP_CHARS = 16000;
export const ERROR_CAP_CHARS = 4096;

function clip(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n… (truncated, ${text.length} chars total)`;
}

export function shouldDeliverOnAgentEnd(
  messages: Array<{ role?: string; stopReason?: string }>,
): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    return !SKIP_STOP_REASONS.has(message.stopReason ?? "");
  }
  return false;
}

export function formatRecord(record: SubagentRecord): string {
  const lines = [
    record.note,
    `Agent ID: ${record.id}`,
    record.sessionId ? `Session ID: ${record.sessionId}` : "",
    `Type: ${record.displayName}`,
    `Status: ${record.status}`,
    record.description ? `Description: ${record.description}` : "",
  ].filter(Boolean);
  if (record.error) lines.push(`Error: ${clip(record.error, ERROR_CAP_CHARS)}`);
  if (record.result) lines.push("", clip(record.result, RESULT_CAP_CHARS));
  return lines.join("\n");
}

export function formatDeliveredResults(records: SubagentRecord[]): string {
  const header = records.length === 1
    ? "Background subagent finished. Incorporate this result into your reply. Do not tell the user to wait."
    : `${records.length} background subagents finished. Incorporate these results into your reply. Do not tell the user to wait.`;
  return [header, ...records.map((record) => formatRecord(record))].join("\n\n---\n\n");
}

export class SubagentDelivery extends TurnDelivery<SubagentRecord> {
  constructor(records: DeliveryRecords<SubagentRecord>, sink: DeliverySink) {
    super(records, sink, formatDeliveredResults);
  }

  /**
   * agent_end hook: non-blocking collect of everything already finished.
   * Still-running children are left alone — their settle either wakes an idle
   * parent or lands in the next agent_end collect.
   */
  collectAtAgentEnd(
    messages: Array<{ role?: string; stopReason?: string }>,
  ): string | null {
    if (!shouldDeliverOnAgentEnd(messages)) return null;
    return this.collect();
  }
}
