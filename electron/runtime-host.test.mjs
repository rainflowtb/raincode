import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { roleForPath, handleRuntimeMessage, setBrowserRequestHandler } = require("./runtime-host.js");

test("light routes never touch the agent SDK graph", () => {
  const light = [
    "/api/home",
    "/api/sessions",
    "/api/web-settings?utilityModels=0",
    "/api/health",
    "/api/files/foo",
    "/api/git/status",
    "/api/accounts",
    "/api/accounts/github/connect",
    "/api/cwd/validate",
    "/api/worktrees",
    "/api/usage",
    "/api/app-update",
    "/api/permissions",
    "/api/mcp",
    "/api/lsp",
    "/api/models-config",
    "/api/models-config/free-models?provider=x",

    "/api/models-config/disabled-models",
    // Built-in catalogs default to disk cache (no ModelRuntime).
    "/api/models-config/provider-models?provider=openai",
    "/api/default-cwd",
    "/api/github?cwd=x",
    "/api/debug/sessions",
    "/api/skills/install",
    "/api/skills/search",
  ];
  for (const path of light) {
    assert.equal(roleForPath(path), "light", path);
  }
});

test("SDK / ModelRuntime routes stay on heavy", () => {
  const heavy = [
    "/api/models",
    // Live catalog refresh for one built-in provider.
    "/api/models-config/provider-models?provider=openai&fresh=1",
    "/api/models-config/model-overrides",
    "/api/models-config/test",
    "/api/models-config/discover",
    "/api/auth/providers",
    "/api/auth/all-providers",
    "/api/auth/login/openai",
    "/api/skills",
    "/api/skills/content",
    "/api/skills/check",
    "/api/skills/update",
    "/api/project-trust?cwd=x",
    "/api/project-memory?cwd=x",
    "/api/project-init",
    "/api/sessions/abc",
    "/api/sessions/abc/context",
    "/api/workspace-journal?sessionId=1",
    "/api/agent/new",
    "/api/agent/running",
    "/api/agent/abc",
    "/api/agent/abc/events",
    "/api/advisor",
    "/api/memory-review",
    "/api/collab",
    // PTY registry is process-local to the heavy runtime (agent bash creates there).
    "/api/cwd/pty",
    "/api/cwd/pty/events?cwd=/tmp",
    "/api/cwd/pty/abc123/events",
    "/api/cwd/pty/abc123/input",
  ];
  for (const path of heavy) {
    assert.equal(roleForPath(path), "heavy", path);
  }
});

function fakeProc(sent) {
  return { connected: true, send: (msg, cb) => { sent.push(msg); cb?.(null); } };
}

test("browser reverse-IPC routes to the injected handler (heavy only)", async () => {
  const sent = [];
  const proc = fakeProc(sent);
  try {
    setBrowserRequestHandler(async (msg) => ({ ok: true, data: { echo: msg.action, viewId: msg.params.viewId } }));
    handleRuntimeMessage({ t: "browser", id: "b1", action: "getState", params: { viewId: "s1" } }, proc, "heavy");
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(sent[0], { t: "browser-res", id: "b1", ok: true, data: { echo: "getState", viewId: "s1" } });

    // Handler errors come back as ok:false, never thrown.
    setBrowserRequestHandler(async () => ({ ok: false, error: "boom" }));
    handleRuntimeMessage({ t: "browser", id: "b2", action: "destroy", params: { viewId: "s1" } }, proc, "heavy");
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(sent[1], { t: "browser-res", id: "b2", ok: false, error: "boom" });
  } finally {
    setBrowserRequestHandler(null);
  }
});

test("browser messages from the light runtime are refused", async () => {
  const sent = [];
  handleRuntimeMessage({ t: "browser", id: "b3", action: "navigate", params: { viewId: "s1", url: "https://x" } }, fakeProc(sent), "light");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent[0].t, "browser-res");
  assert.equal(sent[0].ok, false);
});

test("browser messages without a handler report unavailable", async () => {
  const sent = [];
  handleRuntimeMessage({ t: "browser", id: "b4", action: "getState", params: { viewId: "s1" } }, fakeProc(sent), "heavy");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(sent[0], { t: "browser-res", id: "b4", ok: false, error: "browser unavailable" });
});
