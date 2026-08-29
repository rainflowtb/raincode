import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { assembleTranscript } = await jiti.import("./conversation-nodes.ts");

const user = { role: "user", content: "hi" };
const assistantTools = {
  role: "assistant",
  model: "m",
  provider: "p",
  content: [{ type: "toolCall", toolCallId: "c1", toolName: "read", input: {}, presentation: { card: "read", title: "a.ts" } }],
};
const assistantAnswer = {
  role: "assistant",
  model: "m",
  provider: "p",
  content: [{ type: "text", text: "done" }],
};
const hidden = { role: "custom", customType: "memory-context", content: "x", display: false };

test("settled turn is user + process + answer", () => {
  const nodes = assembleTranscript({
    messages: [user, assistantTools, assistantAnswer],
    entryIds: ["e1", "e2", "e3"],
    stream: null,
    promptRunId: 0,
    busy: false,
  });
  assert.deepEqual(nodes.map((n) => n.kind), ["user", "process", "answer"]);
  assert.equal(nodes[0].id, "entry:e1");
  assert.equal(nodes[1].id, "entry:e1:process");
  assert.equal(nodes[2].id, "entry:e3");
});

test("live tail stays flat message rows plus stream", () => {
  const nodes = assembleTranscript({
    messages: [user, assistantTools],
    entryIds: ["e1", "e2"],
    stream: { role: "assistant", content: [] },
    promptRunId: 7,
    busy: true,
  });
  assert.deepEqual(nodes.map((n) => n.kind), ["user", "message", "stream"]);
  assert.equal(nodes[2].id, "stream:7");
  assert.ok(!nodes.some((n) => n.kind === "process" || n.kind === "answer"));
});

test("orphan assistant is message", () => {
  const nodes = assembleTranscript({
    messages: [assistantAnswer],
    entryIds: ["e9"],
    stream: null,
    promptRunId: 0,
    busy: false,
  });
  assert.deepEqual(nodes.map((n) => n.kind), ["message"]);
});

test("hidden custom is omitted", () => {
  const nodes = assembleTranscript({
    messages: [user, hidden, assistantAnswer],
    entryIds: ["e1", "e2", "e3"],
    stream: null,
    promptRunId: 0,
    busy: false,
  });
  assert.ok(!nodes.some((n) => n.kind === "custom"));
});

test("compaction / bash become those kinds", () => {
  const nodes = assembleTranscript({
    messages: [
      { role: "custom", customType: "compaction", content: "sum", display: true },
      { role: "bashExecution", command: "ls", output: "" },
    ],
    entryIds: ["c1", "b1"],
    stream: null,
    promptRunId: 0,
    busy: false,
  });
  assert.deepEqual(nodes.map((n) => n.kind), ["compaction", "bash"]);
});

test("live turns without entryIds get unique node ids", () => {
  const messages = [user, assistantTools, assistantAnswer];
  const stream = { role: "assistant", content: [] };

  const empty = assembleTranscript({
    messages,
    entryIds: [],
    stream,
    promptRunId: 3,
    busy: true,
  });
  assert.deepEqual(empty.map((n) => n.id), ["idx:0", "idx:1", "idx:2", "stream:3"]);
  assert.equal(new Set(empty.map((n) => n.id)).size, empty.length);

  const firstOnly = assembleTranscript({
    messages,
    entryIds: ["e1"],
    stream,
    promptRunId: 3,
    busy: true,
  });
  assert.deepEqual(firstOnly.map((n) => n.id), ["entry:e1", "idx:1", "idx:2", "stream:3"]);
  assert.equal(new Set(firstOnly.map((n) => n.id)).size, firstOnly.length);
});

test("process node falls back to idx when user entry id is missing", () => {
  const nodes = assembleTranscript({
    messages: [user, assistantTools, assistantAnswer],
    entryIds: [],
    stream: null,
    promptRunId: 0,
    busy: false,
  });
  assert.deepEqual(nodes.map((n) => n.kind), ["user", "process", "answer"]);
  assert.equal(nodes[0].id, "idx:0");
  assert.equal(nodes[1].id, "idx:0:process");
  assert.equal(nodes[2].id, "idx:2");
});

// ── findContinuableTurn (rpc "continue" button gating) ─────────────────────

const { findContinuableTurn } = await jiti.import("./conversation-nodes.ts");

const userMsg = (text) => ({ role: "user", content: text, timestamp: 1 });
const assistantOkMsg = (text = "ok") => ({
  role: "assistant",
  model: "m",
  provider: "p",
  content: [{ type: "text", text }],
  stopReason: "stop",
});
const assistantErroredMsg = () => ({
  role: "assistant",
  model: "m",
  provider: "p",
  content: [],
  stopReason: "error",
  errorMessage: "Connection error.",
});

test("findContinuableTurn returns null for a healthy transcript", () => {
  assert.equal(findContinuableTurn([userMsg("hi"), assistantOkMsg()]), null);
  assert.equal(findContinuableTurn([userMsg("hi")]), null);
  assert.equal(findContinuableTurn([]), null);
});

test("findContinuableTurn locates a single failed turn", () => {
  const messages = [userMsg("你好"), assistantOkMsg(), userMsg("你会做什么?"), assistantErroredMsg()];
  assert.equal(findContinuableTurn(messages), 3);
});

test("findContinuableTurn skips chained auto-retry attempts of the same failed turn", () => {
  // Real session-file shape: the SDK appends one errored assistant per retry
  // attempt, chained parent → child, all empty.
  const messages = [
    userMsg("你好"),
    assistantOkMsg(),
    userMsg("你会做什么?"),
    assistantErroredMsg(),
    assistantErroredMsg(),
    assistantErroredMsg(),
    assistantErroredMsg(),
  ];
  assert.equal(findContinuableTurn(messages), 6);
});

test("findContinuableTurn refuses a healthy tail even after an older error", () => {
  // A healthy assistant came last — there is nothing failed to continue, and
  // continuing the older error would rewind the newer reply.
  const messages = [userMsg("a"), assistantErroredMsg(), userMsg("b"), assistantOkMsg()];
  assert.equal(findContinuableTurn(messages), null);
});

test("findContinuableTurn retries the latest of two consecutive failed turns", () => {
  const messages = [
    userMsg("first"),
    assistantErroredMsg(),
    assistantErroredMsg(),
    userMsg("second"),
    assistantErroredMsg(),
  ];
  assert.equal(findContinuableTurn(messages), 4);
});

test("findContinuableTurn handles a mid-turn error after tool calls", () => {
  // Real shape: user → several toolUse assistants + toolResults → the
  // connection dies mid-turn, auto-retry chains errored assistants at the tail.
  const toolUse = () => ({
    role: "assistant",
    model: "m",
    provider: "p",
    content: [{ type: "thinking", thinking: "x" }, { type: "toolCall", toolCallId: "c", toolName: "read", input: {} }],
    stopReason: "toolUse",
  });
  const toolResult = () => ({ role: "toolResult", toolCallId: "c", toolName: "read", content: [{ type: "text", text: "out" }] });
  const messages = [
    userMsg("check the repo"),
    toolUse(),
    toolResult(),
    toolUse(),
    toolResult(),
    assistantErroredMsg(),
    assistantErroredMsg(),
    assistantErroredMsg(),
  ];
  assert.equal(findContinuableTurn(messages), 7);
});

test("findContinuableTurn refuses when a visible message follows the error", () => {
  // The user already sent a newer message — retrying would leave it dangling.
  const messages = [userMsg("a"), assistantErroredMsg(), userMsg("b")];
  assert.equal(findContinuableTurn(messages), null);
});
