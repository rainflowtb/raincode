import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, before, beforeEach } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

/** @type {typeof import("./file-observations.ts")} */
let obs;
/** @type {typeof import("./agent-edit-tool.ts")} */
let editTool;

before(async () => {
  obs = await jiti.import("./file-observations.ts");
  editTool = await jiti.import("./agent-edit-tool.ts");
});

beforeEach(() => {
  obs.clearFileObservations();
});

function tmpFile(name, content) {
  const dir = mkdtempSync(join(tmpdir(), "edit-tool-"));
  const file = join(dir, name);
  writeFileSync(file, content);
  return { dir, file };
}

describe("file-observations", () => {
  it("tracks unobserved → fresh → stale", () => {
    const { file } = tmpFile("a.ts", "const a = 1;\n");
    assert.equal(obs.checkFileObservation(file, "const a = 1;\n"), "unobserved");
    obs.recordFileObservation(file, "const a = 1;\n");
    assert.equal(obs.checkFileObservation(file, "const a = 1;\n"), "fresh");
    assert.equal(obs.checkFileObservation(file, "const a = 2;\n"), "stale");
  });

  it("serializes concurrent work per path", async () => {
    const order = [];
    await Promise.all([
      obs.withFileLock("/x", async () => { order.push("a1"); await new Promise((r) => setTimeout(r, 20)); order.push("a2"); }),
      obs.withFileLock("/x", async () => { order.push("b1"); await new Promise((r) => setTimeout(r, 5)); order.push("b2"); }),
    ]);
    assert.deepEqual(order, ["a1", "a2", "b1", "b2"]);
  });
});

describe("edit tool guards", () => {
  it("refuses to edit a file that was never read", async () => {
    const { dir } = tmpFile("a.ts", "const a = 1;\n");
    const def = editTool.createRainCodeEditToolDefinition(dir);
    await assert.rejects(
      def.execute("t1", { path: "a.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] }),
      /has not been read in this session — read the file, then retry/,
    );
  });

  it("edits a file that was observed (read), and records the new state", async () => {
    const { dir, file } = tmpFile("a.ts", "const a = 1;\nconst b = 2;\n");
    obs.recordFileObservation(file, "const a = 1;\nconst b = 2;\n");
    const def = editTool.createRainCodeEditToolDefinition(dir);
    const result = await def.execute("t2", {
      path: "a.ts",
      edits: [{ oldText: "const b = 2;", newText: "const b = 3;" }],
    });
    assert.match(result.content[0].text, /Edited a\.ts/);
    assert.equal(result.details.mode, "literal");
    assert.match(result.details.diff, /\+const b = 3;/);
    // A second edit without re-read passes: the tool recorded the post-edit state.
    await def.execute("t3", {
      path: "a.ts",
      edits: [{ oldText: "const b = 3;", newText: "const b = 4;" }],
    });
    assert.match(readFileSync(file, "utf8"), /const b = 4/);
  });

  it("rejects when the file changed on disk since the observation", async () => {
    const { dir, file } = tmpFile("a.ts", "const a = 1;\n");
    obs.recordFileObservation(file, "const a = 1;\n");
    writeFileSync(file, "const a = 99;\n"); // external change
    const def = editTool.createRainCodeEditToolDefinition(dir);
    await assert.rejects(
      def.execute("t4", { path: "a.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] }),
      /file changed since it was read — re-read the file, then retry/,
    );
  });

  it("rejects removed hashline input with the current usage", async () => {
    const { dir } = tmpFile("a.ts", "const a = 1;\n");
    const def = editTool.createRainCodeEditToolDefinition(dir);
    await assert.rejects(
      def.execute("t5", { input: "[a.ts#A1B2]\nSWAP 1.=1:\n+const a = 2;" }),
      /no longer accepts hashline input/,
    );
  });

  it("rejects malformed args with usage", async () => {
    const { dir } = tmpFile("a.ts", "const a = 1;\n");
    const def = editTool.createRainCodeEditToolDefinition(dir);
    await assert.rejects(def.execute("t6", { path: "a.ts" }), /edit requires \{ path, edits/);
  });
});
