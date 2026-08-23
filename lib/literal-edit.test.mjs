import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, before } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

/** @type {typeof import("./literal-edit.ts")} */
let le;

before(async () => {
  le = await jiti.import("./literal-edit.ts");
});

function tmpFile(name, content) {
  const dir = mkdtempSync(join(tmpdir(), "lit-edit-"));
  const file = join(dir, name);
  writeFileSync(file, content);
  return { dir, file };
}

describe("literal-edit engine", () => {
  it("applies a unique replacement and returns a diff", () => {
    const { dir, file } = tmpFile("a.ts", "const a = 1;\nconst b = 2;\n");
    const r = le.applyLiteralEdits(dir, "a.ts", [
      { oldText: "const b = 2;", newText: "const b = 3;" },
    ]);
    assert.equal(r.applied, 1);
    assert.equal(r.replacements, 1);
    assert.match(readFileSync(file, "utf8"), /const b = 3/);
    assert.match(r.diff, /-const b = 2;/);
    assert.match(r.diff, /\+const b = 3;/);
    assert.match(r.summary, /Edited a\.ts \(1 edit\(s\), 1 replacement\(s\)\)/);
  });

  it("rejects oldText that is not found, pointing at re-read", () => {
    const { dir } = tmpFile("a.ts", "const a = 1;\n");
    assert.throws(
      () => le.applyLiteralEdits(dir, "a.ts", [{ oldText: "const b = 2;", newText: "x" }]),
      /edits\[0\]\.oldText was not found in "a\.ts"\. .*re-read the file, then retry/s,
    );
  });

  it("rejects ambiguous oldText with match count and line numbers", () => {
    const { dir } = tmpFile("a.ts", "foo();\nbar();\nfoo();\n");
    assert.throws(
      () => le.applyLiteralEdits(dir, "a.ts", [{ oldText: "foo();", newText: "baz();" }]),
      /matched 2 times in "a\.ts" \(lines 1, 3\).*replaceAll: true/s,
    );
  });

  it("replaceAll replaces every occurrence", () => {
    const { dir, file } = tmpFile("a.ts", "foo();\nbar();\nfoo();\n");
    const r = le.applyLiteralEdits(dir, "a.ts", [
      { oldText: "foo();", newText: "baz();", replaceAll: true },
    ]);
    assert.equal(r.replacements, 2);
    assert.equal(readFileSync(file, "utf8"), "baz();\nbar();\nbaz();\n");
  });

  it("replaceAll composes with single edits in one call", () => {
    const { dir, file } = tmpFile("a.ts", "foo();\nbar();\nfoo();\n");
    le.applyLiteralEdits(dir, "a.ts", [
      { oldText: "foo();", newText: "baz();", replaceAll: true },
      { oldText: "bar();", newText: "qux();" },
    ]);
    assert.equal(readFileSync(file, "utf8"), "baz();\nqux();\nbaz();\n");
  });

  it("rejects empty oldText and no-op edits", () => {
    const { dir } = tmpFile("a.ts", "const a = 1;\n");
    assert.throws(
      () => le.applyLiteralEdits(dir, "a.ts", [{ oldText: "", newText: "x" }]),
      /oldText must be a non-empty string/,
    );
    assert.throws(
      () => le.applyLiteralEdits(dir, "a.ts", [{ oldText: "const a = 1;", newText: "const a = 1;" }]),
      /identical/,
    );
  });

  it("rejects overlapping single edits", () => {
    const { dir } = tmpFile("a.ts", "alpha beta gamma\n");
    assert.throws(
      () => le.applyLiteralEdits(dir, "a.ts", [
        { oldText: "alpha beta", newText: "x" },
        { oldText: "beta gamma", newText: "y" },
      ]),
      /overlap/,
    );
  });

  it("preserves CRLF line endings on write", () => {
    const { dir, file } = tmpFile("a.ts", "const a = 1;\r\nconst b = 2;\r\n");
    le.applyLiteralEdits(dir, "a.ts", [{ oldText: "const b = 2;", newText: "const b = 3;" }]);
    assert.equal(readFileSync(file, "utf8"), "const a = 1;\r\nconst b = 3;\r\n");
  });

  it("matches oldText with LF against a CRLF file", () => {
    const { dir, file } = tmpFile("a.ts", "line1\r\nline2\r\nline3\r\n");
    le.applyLiteralEdits(dir, "a.ts", [{ oldText: "line1\nline2", newText: "one\ntwo" }]);
    assert.equal(readFileSync(file, "utf8"), "one\r\ntwo\r\nline3\r\n");
  });

  it("rejects edits that would leave unparsable JS and leaves the file untouched", () => {
    const { dir, file } = tmpFile("a.ts", "export function f() {\n  return 1;\n}\n");
    assert.throws(
      () => le.applyLiteralEdits(dir, "a.ts", [{ oldText: "  return 1;\n}", newText: "  return 1;" }]),
      /Edit rejected: would leave unparsable source/,
    );
    assert.equal(readFileSync(file, "utf8"), "export function f() {\n  return 1;\n}\n");
  });

  it("does not parse-guard non-JS files", () => {
    const { dir, file } = tmpFile("a.glsl", "void main() {\n  x = 1;\n}\n");
    le.applyLiteralEdits(dir, "a.glsl", [{ oldText: "  x = 1;\n}", newText: "  x = 1;" }]);
    assert.equal(readFileSync(file, "utf8"), "void main() {\n  x = 1;\n");
  });

  it("errors on missing files with the write hint", () => {
    const dir = mkdtempSync(join(tmpdir(), "lit-edit-"));
    assert.throws(
      () => le.applyLiteralEdits(dir, "nope.ts", [{ oldText: "a", newText: "b" }]),
      /File not found: nope\.ts.*use write to create/s,
    );
  });

  it("warns on large files without blocking", () => {
    const big = Array.from({ length: 900 }, (_, i) => `const v${i} = ${i};`).join("\n") + "\n";
    const { dir } = tmpFile("big.ts", big);
    const r = le.applyLiteralEdits(dir, "big.ts", [{ oldText: "const v0 = 0;", newText: "const v0 = 1;" }]);
    assert.match(r.largeFileWarning ?? "", /~900 lines/);
  });
});
