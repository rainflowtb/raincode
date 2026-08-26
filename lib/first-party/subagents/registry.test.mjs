import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..") },
});

/** @type {typeof import("./registry.ts")} */
const registry = await jiti.import("./registry.ts");

const TYPE = {
  name: "general-purpose",
  displayName: "Agent",
  description: "test agent",
  tools: [],
  systemPrompt: "",
  promptMode: "append",
  enabled: true,
};

function makeRegistry(hooks = {}) {
  const calls = { settled: [], started: [] };
  const reg = new registry.SubagentRegistry({
    onChange: () => {},
    onSettle: (record) => calls.settled.push(record.id),
    startQueued: (record, prompt) => calls.started.push([record.id, prompt]),
    maxConcurrent: () => 1,
    ...hooks,
  });
  return { reg, calls };
}

function input(overrides = {}) {
  return {
    ctx: /** @type {any} */ ({}),
    type: TYPE,
    description: "task",
    background: true,
    mode: "continuable",
    depth: 1,
    parentTurnStartedAt: 0,
    ...overrides,
  };
}

describe("SubagentRegistry settlement", () => {
  it("settles first-wins: a second settle is a no-op", () => {
    const { reg, calls } = makeRegistry();
    const record = reg.create(input());
    assert.equal(reg.settle(record, "completed", "done"), true);
    assert.equal(reg.settle(record, "error", undefined, "late"), false);
    assert.equal(record.status, "completed");
    assert.deepEqual(calls.settled, [record.id]);
  });

  it("settle notifies waiters exactly once", () => {
    const { reg } = makeRegistry();
    const record = reg.create(input());
    const seen = [];
    record.waiters.push((snapshot) => seen.push(snapshot.status));
    reg.settle(record, "completed", "done");
    reg.settle(record, "completed", "again");
    assert.deepEqual(seen, ["completed"]);
  });

  it("claimReport is at-most-once and only for finished records", () => {
    const { reg } = makeRegistry();
    const record = reg.create(input());
    assert.equal(reg.claimReport(record), false); // still running
    reg.settle(record, "completed", "done");
    assert.equal(reg.claimReport(record), true);
    assert.equal(reg.claimReport(record), false);
  });

  it("beginTurn reopens a turn and resets delivery flags", () => {
    const { reg } = makeRegistry();
    const record = reg.create(input());
    reg.settle(record, "completed", "done");
    reg.claimReport(record);
    reg.beginTurn(record);
    assert.equal(record.status, "running");
    assert.equal(record.collected, false);
    assert.equal(record.reported, false);
  });

  it("beginTurn throws on a hard-stopped record", () => {
    const { reg } = makeRegistry();
    const record = reg.create(input());
    reg.settle(record, "stopped", undefined, "Killed.");
    assert.throws(() => reg.beginTurn(record), /cannot run/);
  });
});

describe("SubagentRegistry queue", () => {
  it("queues past the cap and pumps exactly one on settle", () => {
    const { reg, calls } = makeRegistry();
    const first = reg.create(input({ queuedPrompt: "p1" }));
    const second = reg.create(input({ queuedPrompt: "p2" }));
    const third = reg.create(input({ queuedPrompt: "p3" }));
    assert.equal(first.status, "running");
    assert.equal(second.status, "queued");
    assert.equal(third.status, "queued");
    reg.settle(first, "completed", "done");
    assert.deepEqual(calls.started, [[second.id, "p2"]]);
    assert.equal(second.queuedPrompt, undefined);
    assert.equal(third.status, "queued");
  });
});

describe("SubagentRegistry child lock", () => {
  it("serializes concurrent turns in call order", async () => {
    const { reg } = makeRegistry();
    const record = reg.create(input());
    const order = [];
    const gate = () => new Promise((resolve) => setTimeout(resolve, 5));
    await Promise.all([
      reg.withLock(record, async () => { await gate(); order.push("a"); }),
      reg.withLock(record, async () => { order.push("b"); }),
      reg.withLock(record, async () => { order.push("c"); }),
    ]);
    assert.deepEqual(order, ["a", "b", "c"]);
  });

  it("keeps the chain alive after a rejection", async () => {
    const { reg } = makeRegistry();
    const record = reg.create(input());
    await assert.rejects(reg.withLock(record, async () => { throw new Error("boom"); }));
    const value = await reg.withLock(record, async () => "recovered");
    assert.equal(value, "recovered");
  });
});

describe("SubagentRegistry hydration", () => {
  it("creates completed, collected records with a fixed id", () => {
    const { reg } = makeRegistry();
    const record = reg.create(input({
      hydrated: { id: "old-agent", sessionId: "sess-1", sessionFile: "/tmp/x.jsonl", startedAt: 5 },
    }));
    assert.equal(record.id, "old-agent");
    assert.equal(record.status, "completed");
    assert.equal(record.collected, true);
    assert.equal(reg.resolve("sess-1"), record);
  });
});
