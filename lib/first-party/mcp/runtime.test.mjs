import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

// getAgentDir() reads this env var at call time; point the agent config store at
// a temp dir before any listMcpServers() call so the test never touches the real
// ~/.raincode/mcp.json. Project layers are avoided by using a fresh temp cwd.
const agentDir = mkdtempSync(join(tmpdir(), "raincode-mcp-runtime-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { NativeMcpRuntime } = await jiti.import("./runtime.ts");

function writeAgentConfig(servers) {
  writeFileSync(join(agentDir, "mcp.json"), `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, "utf8");
}

function seedLiveConnection(runtime, name, tools) {
  const state = { closed: 0 };
  runtime.servers.set(name, {
    name,
    client: { close: async () => { state.closed += 1; } },
    tools: tools.map((toolName) => ({ server: name, name: toolName, description: "" })),
  });
  return state;
}

test("server disabled mid-session is evicted before lookup and call", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "raincode-mcp-cwd-"));
  writeAgentConfig({ "ghost-disabled": { command: "true" } });
  const runtime = new NativeMcpRuntime(cwd);
  const live = seedLiveConnection(runtime, "ghost-disabled", ["haunt"]);

  assert.equal(runtime.findTool("haunt")?.name, "haunt");

  writeAgentConfig({ "ghost-disabled": { command: "true", disabled: true } });

  assert.equal(runtime.findTool("haunt"), undefined);
  assert.equal(live.closed, 1);
  const result = await runtime.call("haunt", {});
  assert.match(result, /not found/i);
});

test("server deleted mid-session is evicted before lookup", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "raincode-mcp-cwd-"));
  writeAgentConfig({ "ghost-deleted": { command: "true" } });
  const runtime = new NativeMcpRuntime(cwd);
  const live = seedLiveConnection(runtime, "ghost-deleted", ["haunt"]);

  assert.equal(runtime.findTool("haunt")?.name, "haunt");

  writeAgentConfig({});

  assert.equal(runtime.findTool("haunt"), undefined);
  assert.equal(live.closed, 1);
});

test("still-enabled servers survive pruning", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "raincode-mcp-cwd-"));
  writeAgentConfig({ keeper: { command: "true" }, goner: { command: "true" } });
  const runtime = new NativeMcpRuntime(cwd);
  seedLiveConnection(runtime, "keeper", ["stay"]);
  const gone = seedLiveConnection(runtime, "goner", ["leave"]);

  writeAgentConfig({ keeper: { command: "true" } });

  assert.equal(runtime.findTool("stay")?.name, "stay");
  assert.equal(runtime.findTool("leave"), undefined);
  assert.equal(gone.closed, 1);
});
