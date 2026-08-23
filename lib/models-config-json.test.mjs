import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const {
  readModelsJson,
  upsertProvider,
} = await jiti.import("./models-config-json.ts");

function createTempAgentDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raincode-models-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function useTempAgentDir(t) {
  const dir = createTempAgentDir(t);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  return dir;
}

test("upsertProvider stamps supportsDeveloperRole:false on unknown OpenAI-compatible hosts", (t) => {
  const agentDir = useTempAgentDir(t);

  const result = upsertProvider("ark", {
    api: "openai-completions",
    baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
    models: [{ id: "glm-5.3", reasoning: true }],
  });
  assert.deepEqual(result, { ok: true });

  const saved = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"));
  assert.equal(saved.providers.ark.compat.supportsDeveloperRole, false);
});

test("upsertProvider respects an explicit supportsDeveloperRole choice", (t) => {
  const agentDir = useTempAgentDir(t);

  const result = upsertProvider("custom", {
    api: "openai-completions",
    baseUrl: "https://example.com/v1",
    compat: { supportsDeveloperRole: true },
  });
  assert.deepEqual(result, { ok: true });

  const saved = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"));
  assert.equal(saved.providers.custom.compat.supportsDeveloperRole, true);
});

test("readModelsJson normalizes legacy files missing developer-role compat", (t) => {
  const agentDir = useTempAgentDir(t);
  fs.writeFileSync(
    path.join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        old: {
          api: "openai-completions",
          baseUrl: "https://old-gateway.example/v1",
        },
      },
    }),
    "utf8",
  );

  const { ok, data } = readModelsJson();
  assert.equal(ok, true);
  assert.equal(data.providers.old.compat.supportsDeveloperRole, false);
});
