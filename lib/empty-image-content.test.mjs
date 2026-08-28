import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { scrubEmptyImageBlocks, EMPTY_IMAGE_NOTE } = jiti("./empty-image-content.ts");

test("replaces empty image blocks with a text note", () => {
  const agent = {
    state: {
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "toolResult",
          content: [
            { type: "image", data: "", mimeType: "image/png" },
            { type: "text", text: "saved" },
          ],
        },
      ],
    },
  };
  assert.equal(scrubEmptyImageBlocks(agent), 1);
  const blocks = agent.state.messages[1].content;
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], { type: "text", text: EMPTY_IMAGE_NOTE });
  assert.deepEqual(blocks[1], { type: "text", text: "saved" });
});

test("treats missing/non-string data as empty", () => {
  const agent = {
    state: {
      messages: [
        { role: "toolResult", content: [{ type: "image", mimeType: "image/png" }] },
        { role: "toolResult", content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] },
      ],
    },
  };
  assert.equal(scrubEmptyImageBlocks(agent), 1);
  assert.equal(agent.state.messages[1].content[0].type, "image");
});

test("no-op on empty or missing state", () => {
  assert.equal(scrubEmptyImageBlocks({}), 0);
  assert.equal(scrubEmptyImageBlocks({ state: null }), 0);
  assert.equal(scrubEmptyImageBlocks({ state: { messages: "nope" } }), 0);
});
