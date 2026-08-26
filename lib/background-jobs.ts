/**
 * Background bash job registry — the single owner of agent-started background
 * process state (heavy runtime only; the PTY routes are pinned heavy in
 * electron/runtime-host.js). Processes themselves live in pty-sessions.ts;
 * completion delivery lives in first-party/jobs-notify.ts.
 *
 * Harness semantics: first-wins settlement, at-most-once completion notice
 * (claimReport), nonzero exits settle as completed with the exit code —
 * only kill/teardown settle as killed.
 */
import { destroyPtySession, getPtySession, subscribePtySession } from "./pty-sessions";

export type JobStatus = "running" | "completed" | "killed";

export type BackgroundJob = {
  id: string;
  label: string;
  status: JobStatus;
  ptyId: string;
  ownerSessionId?: string;
  exitCode?: number;
  startedAt: number;
  completedAt?: number;
  /** A completion notice for this job was sent or claimed — at most once. */
  reported: boolean;
};

export type JobOutputRead = {
  text: string;
  /** True when unread output was evicted from the PTY history cap. */
  lossy: boolean;
  status: JobStatus;
  exitCode?: number;
};

export const MAX_BACKGROUND_JOBS_PER_SESSION = 8;
const WAIT_DEFAULT_MS = 30_000;
const WAIT_MAX_MS = 600_000;

declare global {
  var __raincodeBackgroundJobs: Map<string, LiveJob> | undefined;
  var __raincodeBackgroundJobSeq: number | undefined;
  var __raincodeBackgroundJobListeners: Map<string, Set<(job: BackgroundJob) => void>> | undefined;
}

type LiveJob = BackgroundJob & {
  /** Absolute char offset into the PTY output stream consumed by job_output. */
  readOffset: number;
  waiters: Array<(job: BackgroundJob) => void>;
  unsubscribe?: () => void;
};

function jobs(): Map<string, LiveJob> {
  if (!globalThis.__raincodeBackgroundJobs) globalThis.__raincodeBackgroundJobs = new Map();
  return globalThis.__raincodeBackgroundJobs;
}

function settleListeners(): Map<string, Set<(job: BackgroundJob) => void>> {
  if (!globalThis.__raincodeBackgroundJobListeners) {
    globalThis.__raincodeBackgroundJobListeners = new Map();
  }
  return globalThis.__raincodeBackgroundJobListeners;
}

function publicJob(job: LiveJob): BackgroundJob {
  return {
    id: job.id,
    label: job.label,
    status: job.status,
    ptyId: job.ptyId,
    ownerSessionId: job.ownerSessionId,
    exitCode: job.exitCode,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    reported: job.reported,
  };
}

function emitSettled(job: LiveJob): void {
  const key = job.ownerSessionId ?? "";
  for (const listener of settleListeners().get(key) ?? []) {
    try {
      listener(publicJob(job));
    } catch {
      // listener faults must not break settlement
    }
  }
}

/** Subscribe to settlements for one owner session. Returns an unsubscribe fn. */
export function onJobSettled(ownerSessionId: string, listener: (job: BackgroundJob) => void): () => void {
  const listeners = settleListeners();
  let set = listeners.get(ownerSessionId);
  if (!set) {
    set = new Set();
    listeners.set(ownerSessionId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(ownerSessionId);
  };
}

export function startJob(input: {
  label: string;
  ptyId: string;
  ownerSessionId?: string;
}): BackgroundJob {
  const running = [...jobs().values()].filter(
    (job) => job.status === "running" && job.ownerSessionId === input.ownerSessionId,
  );
  if (running.length >= MAX_BACKGROUND_JOBS_PER_SESSION) {
    throw new Error(
      `Too many background jobs running (${running.length}/${MAX_BACKGROUND_JOBS_PER_SESSION}). `
      + "Use job_kill on one that stopped mattering, then retry.",
    );
  }
  globalThis.__raincodeBackgroundJobSeq = (globalThis.__raincodeBackgroundJobSeq ?? 0) + 1;
  const job: LiveJob = {
    id: `bash-${globalThis.__raincodeBackgroundJobSeq}`,
    label: input.label,
    status: "running",
    ptyId: input.ptyId,
    ownerSessionId: input.ownerSessionId,
    startedAt: Date.now(),
    reported: false,
    readOffset: 0,
    waiters: [],
  };
  jobs().set(job.id, job);
  // The registry owns settlement: PTY exit settles the job exactly once.
  try {
    job.unsubscribe = subscribePtySession(input.ptyId, (event) => {
      if (event.type === "exit") settleJob(job.id, { exitCode: event.exitCode });
    });
  } catch {
    // PTY already gone — settle immediately so the job cannot hang.
    job.unsubscribe = undefined;
    settleJob(job.id, { exitCode: 1 });
  }
  return publicJob(job);
}

/** First-wins: only a running job settles; later calls are no-ops. */
export function settleJob(id: string, outcome: { exitCode?: number; killed?: boolean }): boolean {
  const job = jobs().get(id);
  if (!job || job.status !== "running") return false;
  job.status = outcome.killed ? "killed" : "completed";
  job.exitCode = outcome.exitCode;
  job.completedAt = Date.now();
  try {
    job.unsubscribe?.();
  } catch {
    // already detached
  }
  job.unsubscribe = undefined;
  const snapshot = publicJob(job);
  for (const waiter of job.waiters.splice(0)) waiter(snapshot);
  emitSettled(job);
  return true;
}

/** Kill the process and settle as killed. Idempotent. */
export function killJob(id: string): boolean {
  const job = jobs().get(id);
  if (!job) return false;
  if (job.status !== "running") return true;
  // Settle first (unsubscribes the PTY listener) so the exit event from the
  // kill cannot race us into "completed" — a kill stays killed.
  settleJob(id, { killed: true });
  try {
    destroyPtySession(job.ptyId);
  } catch {
    // process already gone
  }
  return true;
}

export function getJob(id: string): BackgroundJob | undefined {
  const job = jobs().get(id);
  return job ? publicJob(job) : undefined;
}

export function listJobs(ownerSessionId?: string): BackgroundJob[] {
  return [...jobs().values()]
    .filter((job) => !ownerSessionId || job.ownerSessionId === ownerSessionId)
    .sort((a, b) => a.startedAt - b.startedAt)
    .map(publicJob);
}

/** Incremental read: returns output since the previous job_output call. */
export function readJobOutput(id: string): JobOutputRead | undefined {
  const job = jobs().get(id);
  if (!job) return undefined;
  const pty = getPtySession(job.ptyId);
  if (pty) {
    const slice = pty.readHistory(job.readOffset);
    job.readOffset = slice.nextOffset;
    return { text: slice.text, lossy: slice.lossy, status: job.status, exitCode: job.exitCode };
  }
  // PTY record already reaped after exit — nothing left to read.
  return { text: "", lossy: false, status: job.status, exitCode: job.exitCode };
}

/** Bounded wait for settlement; resolves null on timeout/abort. */
export function waitJob(id: string, input?: { signal?: AbortSignal; timeoutMs?: number }): Promise<BackgroundJob | null> {
  const job = jobs().get(id);
  if (!job) return Promise.resolve(null);
  if (job.status !== "running") return Promise.resolve(publicJob(job));
  const timeoutMs = Math.max(
    1_000,
    Math.min(WAIT_MAX_MS, Math.floor(input?.timeoutMs ?? WAIT_DEFAULT_MS)),
  );
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: BackgroundJob | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      input?.signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => finish(publicJob(job));
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    if (input?.signal) {
      if (input.signal.aborted) {
        onAbort();
        return;
      }
      input.signal.addEventListener("abort", onAbort, { once: true });
    }
    job.waiters.push(finish);
  });
}

/** Claim the completion notice for a settled job. False = already claimed. */
export function claimJobReport(id: string): boolean {
  const job = jobs().get(id);
  if (!job || job.status === "running" || job.reported) return false;
  job.reported = true;
  return true;
}

/** Settled jobs for one owner whose completion never reached the agent. */
export function finishedUndeliveredJobs(ownerSessionId: string): BackgroundJob[] {
  return [...jobs().values()]
    .filter((job) => job.ownerSessionId === ownerSessionId && job.status !== "running" && !job.reported)
    .map(publicJob);
}

/**
 * Session teardown: kill every background job the session owns and suppress
 * their notices (the owner is gone). Wired into wrapper.onDestroy.
 */
export function teardownJobsForSession(ownerSessionId: string): void {
  for (const job of jobs().values()) {
    if (job.ownerSessionId !== ownerSessionId) continue;
    if (job.status === "running") {
      try {
        destroyPtySession(job.ptyId);
      } catch {
        // process already gone
      }
      settleJob(job.id, { killed: true });
    }
    job.reported = true;
    jobs().delete(job.id);
  }
  settleListeners().delete(ownerSessionId);
}
