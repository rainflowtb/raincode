import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") },
});

/** @type {typeof import("./background-jobs.ts")} */
const jobs = await jiti.import("./background-jobs.ts");

/** Insert a minimal fake PTY session into the process-local registry. */
function fakePty(id, history = []) {
  const session = {
    id,
    cwd: "/tmp",
    shell: "/bin/bash",
    pty: { pid: 2_000_000_000, write() {}, resize() {}, kill() {} },
    cols: 80,
    rows: 32,
    source: "agent",
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    exited: false,
    exitCode: undefined,
    published: true,
    destroyed: false,
    listeners: new Set(),
    history: [...history],
    historyBytes: history.join("").length,
    historyDropped: 0,
    readHistory(fromOffset) {
      const joined = session.history.join("");
      const base = session.historyDropped;
      const lossy = fromOffset < base;
      const start = Math.max(fromOffset, base) - base;
      return { text: joined.slice(start), nextOffset: base + joined.length, lossy };
    },
  };
  globalThis.__raincodePtySessions.set(id, session);
  return session;
}

function pushData(session, text) {
  session.history.push(text);
  session.historyBytes += text.length;
  for (const listener of session.listeners) listener({ type: "data", data: text });
}

function exitPty(session, exitCode) {
  session.exited = true;
  session.exitCode = exitCode;
  for (const listener of session.listeners) listener({ type: "exit", exitCode });
  session.listeners.clear();
}

beforeEach(() => {
  globalThis.__raincodeBackgroundJobs = new Map();
  globalThis.__raincodeBackgroundJobListeners = new Map();
  globalThis.__raincodePtySessions = new Map();
});

describe("startJob", () => {
  it("assigns sequential bash-N ids and starts running", () => {
    fakePty("pty-1");
    const job = jobs.startJob({ label: "npm run dev", ptyId: "pty-1", ownerSessionId: "s1" });
    assert.match(job.id, /^bash-\d+$/);
    assert.equal(job.status, "running");
    assert.equal(job.ownerSessionId, "s1");
  });

  it("enforces the per-owner cap and rejects beyond it", () => {
    for (let i = 0; i < jobs.MAX_BACKGROUND_JOBS_PER_SESSION; i += 1) {
      fakePty(`pty-cap-${i}`);
      jobs.startJob({ label: `cmd ${i}`, ptyId: `pty-cap-${i}`, ownerSessionId: "s1" });
    }
    fakePty("pty-cap-x");
    assert.throws(
      () => jobs.startJob({ label: "one too many", ptyId: "pty-cap-x", ownerSessionId: "s1" }),
      /Too many background jobs/,
    );
    // A different owner is unaffected.
    const other = jobs.startJob({ label: "fine", ptyId: "pty-cap-x", ownerSessionId: "s2" });
    assert.equal(other.status, "running");
  });

  it("settles immediately when the PTY is already gone", () => {
    const job = jobs.startJob({ label: "gone", ptyId: "pty-missing", ownerSessionId: "s1" });
    assert.equal(job.status, "completed");
    assert.equal(job.exitCode, 1);
  });
});

describe("settlement (harness semantics)", () => {
  it("a nonzero exit settles as completed with the exit code", () => {
    fakePty("pty-2");
    const job = jobs.startJob({ label: "npm test", ptyId: "pty-2", ownerSessionId: "s1" });
    exitPty(globalThis.__raincodePtySessions.get("pty-2"), 2);
    const settled = jobs.getJob(job.id);
    assert.equal(settled.status, "completed");
    assert.equal(settled.exitCode, 2);
  });

  it("settle is first-wins", () => {
    fakePty("pty-3");
    const job = jobs.startJob({ label: "cmd", ptyId: "pty-3", ownerSessionId: "s1" });
    assert.equal(jobs.settleJob(job.id, { exitCode: 0 }), true);
    assert.equal(jobs.settleJob(job.id, { exitCode: 9 }), false);
    assert.equal(jobs.getJob(job.id).exitCode, 0);
  });

  it("killJob settles as killed even when the exit event races in", () => {
    const pty = fakePty("pty-4");
    const job = jobs.startJob({ label: "npm run dev", ptyId: "pty-4", ownerSessionId: "s1" });
    assert.equal(jobs.killJob(job.id), true);
    exitPty(pty, 143); // late exit from the kill — must not flip to completed
    const settled = jobs.getJob(job.id);
    assert.equal(settled.status, "killed");
    // Idempotent.
    assert.equal(jobs.killJob(job.id), true);
    assert.equal(jobs.killJob("bash-nope"), false);
  });

  it("notifies settle listeners exactly once", () => {
    fakePty("pty-5");
    const seen = [];
    const off = jobs.onJobSettled("s1", (job) => seen.push(job.id));
    const job = jobs.startJob({ label: "cmd", ptyId: "pty-5", ownerSessionId: "s1" });
    jobs.settleJob(job.id, { exitCode: 0 });
    jobs.settleJob(job.id, { exitCode: 1 });
    assert.deepEqual(seen, [job.id]);
    off();
  });
});

describe("reporting", () => {
  it("claimReport is at-most-once and finishedUndeliveredJobs filters", () => {
    fakePty("pty-6");
    const job = jobs.startJob({ label: "cmd", ptyId: "pty-6", ownerSessionId: "s1" });
    assert.deepEqual(jobs.finishedUndeliveredJobs("s1"), []);
    jobs.settleJob(job.id, { exitCode: 0 });
    assert.equal(jobs.finishedUndeliveredJobs("s1").length, 1);
    assert.equal(jobs.claimJobReport(job.id), true);
    assert.equal(jobs.claimJobReport(job.id), false);
    assert.deepEqual(jobs.finishedUndeliveredJobs("s1"), []);
    assert.equal(jobs.claimJobReport("bash-nope"), false);
  });
});

describe("readJobOutput", () => {
  it("reads incrementally by absolute offset", () => {
    const pty = fakePty("pty-7", ["first\n"]);
    const job = jobs.startJob({ label: "cmd", ptyId: "pty-7", ownerSessionId: "s1" });
    const r1 = jobs.readJobOutput(job.id);
    assert.equal(r1.text, "first\n");
    assert.equal(r1.lossy, false);
    pushData(pty, "second\n");
    const r2 = jobs.readJobOutput(job.id);
    assert.equal(r2.text, "second\n");
    assert.equal(jobs.readJobOutput(job.id).text, "");
  });

  it("flags lossy reads when history evicted the offset", () => {
    const pty = fakePty("pty-8", ["old\n"]);
    const job = jobs.startJob({ label: "cmd", ptyId: "pty-8", ownerSessionId: "s1" });
    // Evict the head before any read: historyDropped moves past offset 0.
    pty.history = ["new\n"];
    pty.historyBytes = 4;
    pty.historyDropped = 4;
    const read = jobs.readJobOutput(job.id);
    assert.equal(read.lossy, true);
    assert.equal(read.text, "new\n");
  });
});

describe("waitJob", () => {
  it("resolves with the job when it settles", async () => {
    fakePty("pty-9");
    const job = jobs.startJob({ label: "cmd", ptyId: "pty-9", ownerSessionId: "s1" });
    const waiting = jobs.waitJob(job.id, { timeoutMs: 60_000 });
    setTimeout(() => jobs.settleJob(job.id, { exitCode: 3 }), 20);
    const settled = await waiting;
    assert.equal(settled.exitCode, 3);
  });

  it("resolves null on timeout", async () => {
    fakePty("pty-10");
    const job = jobs.startJob({ label: "cmd", ptyId: "pty-10", ownerSessionId: "s1" });
    const result = await jobs.waitJob(job.id, { timeoutMs: 1 }); // clamps to 1s
    assert.equal(result, null);
  });
});

describe("teardownJobsForSession", () => {
  it("kills running jobs, suppresses notices, and drops records", () => {
    const pty = fakePty("pty-11");
    const running = jobs.startJob({ label: "cmd", ptyId: "pty-11", ownerSessionId: "s1" });
    fakePty("pty-12");
    const otherOwner = jobs.startJob({ label: "cmd", ptyId: "pty-12", ownerSessionId: "s2" });
    jobs.teardownJobsForSession("s1");
    assert.equal(jobs.getJob(running.id), undefined);
    assert.equal(pty.destroyed, true);
    exitPty(pty, 137); // late exit — record is gone, nothing throws
    assert.equal(jobs.getJob(otherOwner.id)?.status, "running");
  });
});
