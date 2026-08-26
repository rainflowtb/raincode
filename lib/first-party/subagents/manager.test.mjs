import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..") },
});

/** @type {typeof import("./manager.ts")} */
const { NativeSubagentManager } = await jiti.import("./manager.ts");

describe("NativeSubagentManager", () => {
  it("tracks the current parent turn start on beginPrompt", () => {
    const manager = new NativeSubagentManager();
    assert.equal(manager.currentTurnStartMs, 0);
    manager.beginPrompt();
    assert.ok(manager.currentTurnStartMs > 0);
  });

  it("wait() throws for an unknown id", async () => {
    const manager = new NativeSubagentManager();
    await assert.rejects(() => manager.wait("missing"), /not found/);
  });

  it("waitPublished() throws for an unknown id", async () => {
    const manager = new NativeSubagentManager();
    await assert.rejects(() => manager.waitPublished("missing"), /not found/);
  });

  it("followup() throws for an unknown id", async () => {
    const manager = new NativeSubagentManager();
    await assert.rejects(() => manager.followup("missing", "more"), /not found/);
  });

  it("deliver() throws for an unknown id", async () => {
    const manager = new NativeSubagentManager();
    await assert.rejects(() => manager.deliver("missing", "more"), /not found/);
  });

  it("interrupt() reports a missing id", async () => {
    const manager = new NativeSubagentManager();
    assert.match(await manager.interrupt("missing"), /not found/);
  });

  it("kill() returns false for an unknown id", async () => {
    const manager = new NativeSubagentManager();
    assert.equal(await manager.kill("missing"), false);
  });

  it("interruptAll() resolves with no children", async () => {
    const manager = new NativeSubagentManager();
    await manager.interruptAll();
  });

  it("teardown() is idempotent", () => {
    const manager = new NativeSubagentManager();
    manager.teardown();
    manager.teardown();
  });

  it("markCollected tolerates unknown ids", () => {
    const manager = new NativeSubagentManager();
    manager.markCollected("missing");
  });

  it("finishedUndelivered/claimReport feed delivery without a live record", () => {
    const manager = new NativeSubagentManager();
    assert.deepEqual(manager.finishedUndelivered(), []);
    assert.equal(manager.claimReport("missing"), false);
  });
});
