import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { setEphemeralContextMessage, pruneEphemeralContextMessages } = await import("./ephemeral-context.ts");

function agentWith(messages) {
  return { state: { messages } };
}

describe("setEphemeralContextMessage", () => {
  it("appends a custom message to state.messages", () => {
    const agent = agentWith([{ role: "user", content: "hi" }]);
    setEphemeralContextMessage(agent, "memory-context", "block");
    assert.equal(agent.state.messages.length, 2);
    const last = agent.state.messages.at(-1);
    assert.equal(last.role, "custom");
    assert.equal(last.customType, "memory-context");
    assert.equal(last.content, "block");
    assert.equal(last.display, false);
  });

  it("replaces the previous block of the same customType (at most one)", () => {
    const agent = agentWith([]);
    setEphemeralContextMessage(agent, "memory-context", "first");
    setEphemeralContextMessage(agent, "memory-context", "second");
    setEphemeralContextMessage(agent, "memory-context", "third");
    const customs = agent.state.messages.filter((m) => m.customType === "memory-context");
    assert.equal(customs.length, 1);
    assert.equal(customs[0].content, "third");
  });

  it("keeps other customTypes and regular messages untouched", () => {
    const agent = agentWith([
      { role: "custom", customType: "agent-mode-brief", content: "brief" },
      { role: "assistant", content: [] },
    ]);
    setEphemeralContextMessage(agent, "memory-context", "block");
    assert.equal(agent.state.messages.length, 3);
    assert.ok(agent.state.messages.some((m) => m.customType === "agent-mode-brief"));
  });

  it("content === null prunes without inserting", () => {
    const agent = agentWith([
      { role: "custom", customType: "memory-context", content: "stale" },
      { role: "user", content: "hi" },
    ]);
    setEphemeralContextMessage(agent, "memory-context", null);
    assert.deepEqual(agent.state.messages, [{ role: "user", content: "hi" }]);
  });

  it("is a no-op when state is missing", () => {
    const agent = {};
    setEphemeralContextMessage(agent, "memory-context", "block");
    assert.equal(agent.state, undefined);
  });
});

describe("pruneEphemeralContextMessages", () => {
  it("removes only the listed customTypes (legacy persisted residue)", () => {
    const agent = agentWith([
      { role: "custom", customType: "memory-context", content: "old" },
      { role: "custom", customType: "agent-mode-brief", content: "old" },
      { role: "custom", customType: "unrelated", content: "keep" },
      { role: "user", content: "hi" },
    ]);
    pruneEphemeralContextMessages(agent, ["memory-context", "agent-mode-brief"]);
    assert.deepEqual(
      agent.state.messages.map((m) => m.customType ?? m.role),
      ["unrelated", "user"],
    );
  });

  it("leaves the array reference alone when nothing matches", () => {
    const messages = [{ role: "user", content: "hi" }];
    const agent = agentWith(messages);
    pruneEphemeralContextMessages(agent, ["memory-context"]);
    assert.equal(agent.state.messages, messages);
  });

  it("tolerates missing state/messages", () => {
    pruneEphemeralContextMessages({}, ["memory-context"]);
    pruneEphemeralContextMessages({ state: null }, ["memory-context"]);
    pruneEphemeralContextMessages({ state: {} }, ["memory-context"]);
  });
});
