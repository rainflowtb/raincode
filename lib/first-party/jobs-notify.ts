/**
 * Background bash job completion notices — the single path by which job exits
 * reach the session. Collected non-blockingly at agent_end while busy;
 * budgeted wake (shared TurnDelivery) while idle. Notices are hidden
 * job-results messages; state lives in lib/background-jobs.ts.
 */
import type { ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { JOB_RESULTS_CUSTOM_TYPE } from "../types";
import { TurnDelivery } from "./turn-delivery";
import { shouldDeliverOnAgentEnd } from "./subagents/delivery";
import {
  claimJobReport,
  finishedUndeliveredJobs,
  onJobSettled,
  type BackgroundJob,
} from "../background-jobs";

function formatJobLine(job: BackgroundJob): string {
  const outcome = job.status === "killed"
    ? "was killed"
    : `finished [exit code: ${job.exitCode ?? 0}]`;
  return `Background job ${job.id} (${job.label}) ${outcome}. Read its output with job_output.`;
}

export function formatJobResults(jobs: BackgroundJob[]): string {
  return jobs.map(formatJobLine).join("\n");
}

export function createJobsNotifyInlineExtension(): InlineExtension {
  return {
    name: "jobs-notify",
    factory(pi) {
      let extCtx: ExtensionContext | undefined;
      let ownerSessionId: string | undefined;
      let unsubscribe: (() => void) | undefined;

      const delivery = new TurnDelivery(
        {
          finishedUndelivered: () => (ownerSessionId ? finishedUndeliveredJobs(ownerSessionId) : []),
          claimReport: (id: string) => claimJobReport(id),
        },
        {
          isParentIdle: () => {
            try {
              return extCtx?.isIdle() === true;
            } catch {
              return false;
            }
          },
          wakeParent: (message) => {
            try {
              pi.sendMessage(
                { customType: JOB_RESULTS_CUSTOM_TYPE, content: message, display: false },
                { deliverAs: "followUp", triggerTurn: true },
              );
            } catch {
              // Parent session already gone.
            }
          },
        },
        formatJobResults,
      );

      pi.on("session_start", (_event, ctx) => {
        extCtx = ctx;
        ownerSessionId = ctx.sessionManager.getSessionId() || undefined;
        unsubscribe?.();
        unsubscribe = ownerSessionId
          ? onJobSettled(ownerSessionId, (job) => delivery.notifySettled(job))
          : undefined;
      });
      pi.on("input", (_event, ctx) => {
        // User-authored input refills the completion-wake budget.
        if (ctx.isIdle()) delivery.resetWakeBudget();
      });
      pi.on("agent_end", (event, ctx) => {
        if (ctx.signal?.aborted) return;
        if (!shouldDeliverOnAgentEnd(event.messages)) return;
        const delivered = delivery.collect();
        if (!delivered || ctx.signal?.aborted) return;
        pi.sendMessage(
          { customType: JOB_RESULTS_CUSTOM_TYPE, content: delivered, display: false },
          { deliverAs: "followUp" },
        );
      });
    },
  };
}
