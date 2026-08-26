import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..") },
});

/** @type {typeof import("./delivery.ts")} */
const delivery = await jiti.import("./delivery.ts");

function record(overrides = {}) {
  return {
    id: "agent-1",
    type: "Explore",
    displayName: "Explore",
    description: "Scout files",
    status: "completed",
    result: "found z-index 1200 vs 1000",
    startedAt: 1,
    ...overrides,
  };
}

function fakeStore(initial = []) {
  const records = new Map(initial.map((item) => [item.id, { collected: false, reported: false, ...item }]));
  return {
    records,
    finishedUndelivered() {
      return [...records.values()].filter(
        (item) => ["completed", "error", "stopped", "aborted"].includes(item.status)
          && !item.collected && !item.reported,
      );
    },
    claimReport(id) {
      const item = records.get(id);
      if (!item || item.collected || item.reported) return false;
      item.reported = true;
      item.collected = true;
      return true;
    },
  };
}

function fakeSink(idle) {
  const wakes = [];
  return {
    wakes,
    isParentIdle: () => idle,
    wakeParent: (message) => wakes.push(message),
  };
}

describe("shouldDeliverOnAgentEnd", () => {
  it("skips aborted, error, and length stops", () => {
    assert.equal(delivery.shouldDeliverOnAgentEnd([{ role: "assistant", stopReason: "aborted" }]), false);
    assert.equal(delivery.shouldDeliverOnAgentEnd([{ role: "assistant", stopReason: "error" }]), false);
    assert.equal(delivery.shouldDeliverOnAgentEnd([{ role: "assistant", stopReason: "length" }]), false);
  });

  it("delivers after a clean stop", () => {
    assert.equal(delivery.shouldDeliverOnAgentEnd([{ role: "assistant", stopReason: "stop" }]), true);
  });
});

describe("collectAtAgentEnd (non-blocking)", () => {
  it("returns null when nothing finished", () => {
    const store = fakeStore([record({ status: "running", result: undefined })]);
    const d = new delivery.SubagentDelivery(store, fakeSink(false));
    assert.equal(d.collectAtAgentEnd([{ role: "assistant", stopReason: "stop" }]), null);
  });

  it("collects finished records once and claims them", () => {
    const store = fakeStore([record()]);
    const d = new delivery.SubagentDelivery(store, fakeSink(false));
    const text = d.collectAtAgentEnd([{ role: "assistant", stopReason: "stop" }]);
    assert.match(text ?? "", /found z-index 1200 vs 1000/);
    assert.match(text ?? "", /Incorporate this result/);
    // Second agent_end must not redeliver.
    assert.equal(d.collectAtAgentEnd([{ role: "assistant", stopReason: "stop" }]), null);
  });

  it("does not collect after an aborted parent turn", () => {
    const store = fakeStore([record()]);
    const d = new delivery.SubagentDelivery(store, fakeSink(false));
    const text = d.collectAtAgentEnd([{ role: "assistant", stopReason: "aborted" }]);
    assert.equal(text, null);
    // Still deliverable later — abort skips, it does not consume.
    assert.match(
      d.collectAtAgentEnd([{ role: "assistant", stopReason: "stop" }]) ?? "",
      /found z-index/,
    );
  });
});

describe("notifySettled (idle wake)", () => {
  it("does not wake a busy parent", () => {
    const store = fakeStore([record()]);
    const sink = fakeSink(false);
    const d = new delivery.SubagentDelivery(store, sink);
    d.notifySettled(store.records.get("agent-1"));
    assert.equal(sink.wakes.length, 0);
    assert.equal(store.records.get("agent-1").reported, false);
  });

  it("wakes an idle parent exactly once per result", () => {
    const store = fakeStore([record()]);
    const sink = fakeSink(true);
    const d = new delivery.SubagentDelivery(store, sink);
    d.notifySettled(store.records.get("agent-1"));
    d.notifySettled(store.records.get("agent-1"));
    assert.equal(sink.wakes.length, 1);
    assert.match(sink.wakes[0], /found z-index/);
  });

  it("stops waking after MAX_CONSECUTIVE_WAKES and refills on user input", () => {
    const store = fakeStore([
      record({ id: "a" }),
      record({ id: "b" }),
      record({ id: "c" }),
      record({ id: "d" }),
    ]);
    const sink = fakeSink(true);
    const d = new delivery.SubagentDelivery(store, sink);
    for (const id of ["a", "b", "c", "d"]) d.notifySettled(store.records.get(id));
    assert.equal(sink.wakes.length, delivery.MAX_CONSECUTIVE_WAKES);
    assert.equal(store.records.get("d").reported, false);
    d.resetWakeBudget();
    d.notifySettled(store.records.get("d"));
    assert.equal(sink.wakes.length, delivery.MAX_CONSECUTIVE_WAKES + 1);
  });
});

describe("formatRecord caps", () => {
  it("clips oversized results and errors", () => {
    const text = delivery.formatRecord(record({
      result: "x".repeat(delivery.RESULT_CAP_CHARS + 100),
      error: "e".repeat(delivery.ERROR_CAP_CHARS + 100),
    }));
    assert.match(text, /truncated/);
    assert.ok(text.length < delivery.RESULT_CAP_CHARS + delivery.ERROR_CAP_CHARS + 500);
  });
});
