/**
 * Agent tools for background bash jobs (bash background: true). The job
 * registry in background-jobs.ts owns the state; these tools only read it,
 * wait on it, or kill through it.
 */
import { Type } from "typebox";
import { errorResult, type ToolDefinitionLike } from "./agent-tool-types";
import {
  getJob,
  killJob,
  listJobs,
  readJobOutput,
  waitJob,
  type BackgroundJob,
} from "./background-jobs";

function textResult(text: string, details: Record<string, unknown> = {}, isError = false) {
  return { content: [{ type: "text" as const, text }], details, ...(isError ? { isError: true } : {}) };
}

function statusLine(job: { status: string; exitCode?: number }): string {
  if (job.status === "running") return "[status: running]";
  if (job.status === "killed") return "[killed]";
  return `[exit code: ${job.exitCode ?? 0}]`;
}

function describeJob(job: BackgroundJob): string {
  return `${job.id}  ${job.status}${job.exitCode != null ? ` (${job.exitCode})` : ""}  ${job.label}`;
}

export function createJobTools(getAgentSessionId?: () => string | undefined): ToolDefinitionLike[] {
  const jobOutput: ToolDefinitionLike = {
    name: "job_output",
    label: "Job output",
    description:
      "Read output from a background bash job (started with bash background: true). Returns output since your last read. Set wait: true to block until the job exits or timeout_ms (default 30000, max 600000) elapses — a timeout returns the current snapshot, not an error.",
    promptSnippet: "job_output: Read or wait on a background job's output",
    parameters: Type.Object({
      job_id: Type.String({ description: "Job id returned by bash (e.g. bash-1)." }),
      wait: Type.Optional(Type.Boolean({ description: "Wait for the job to finish before returning." })),
      timeout_ms: Type.Optional(Type.Number({ description: "Wait bound in ms (default 30000, max 600000)." })),
    }),
    async execute(_id, args, signal) {
      try {
        const jobId = String(args.job_id ?? "");
        const current = getJob(jobId);
        if (!current) return textResult(`Job not found: "${jobId}". Use job_list to see this session's jobs.`, {}, true);
        if (args.wait === true && current.status === "running") {
          await waitJob(jobId, { signal, timeoutMs: typeof args.timeout_ms === "number" ? args.timeout_ms : undefined });
        }
        const read = readJobOutput(jobId);
        if (!read) return textResult(`Job not found: "${jobId}".`, {}, true);
        const lines: string[] = [];
        if (read.lossy) lines.push("[earlier output was dropped — the terminal history cap was exceeded]");
        lines.push(read.text || "(no new output)");
        lines.push(statusLine(read));
        return textResult(lines.join("\n"), { job: getJob(jobId) });
      } catch (error) {
        return errorResult(error);
      }
    },
  };

  const jobList: ToolDefinitionLike = {
    name: "job_list",
    label: "List jobs",
    description: "List this session's background bash jobs with status and exit codes.",
    promptSnippet: "job_list: List background jobs",
    parameters: Type.Object({}),
    async execute() {
      try {
        const jobs = listJobs(getAgentSessionId?.());
        if (jobs.length === 0) return textResult("No background jobs.");
        return textResult(jobs.map(describeJob).join("\n"), { jobs });
      } catch (error) {
        return errorResult(error);
      }
    },
  };

  const jobKill: ToolDefinitionLike = {
    name: "job_kill",
    label: "Kill job",
    description: "Stop a background bash job and settle it as killed. Idempotent.",
    promptSnippet: "job_kill: Stop a background job",
    parameters: Type.Object({
      job_id: Type.String({ description: "Job id returned by bash (e.g. bash-1)." }),
    }),
    async execute(_id, args) {
      try {
        const jobId = String(args.job_id ?? "");
        const killed = killJob(jobId);
        return textResult(killed ? `Job ${jobId} killed.` : `Job not found: "${jobId}".`);
      } catch (error) {
        return errorResult(error);
      }
    },
  };

  return [jobOutput, jobList, jobKill];
}
