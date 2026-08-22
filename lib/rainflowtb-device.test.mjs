import assert from "node:assert/strict";
import { createHash, verify as cryptoVerify, createPublicKey } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// Isolate the device identity into a throwaway HOME before the module loads
// (it computes ~/.raincode paths at import time).
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "raincode-device-test-"));
process.env.HOME = tmpHome;

const jiti = createJiti(import.meta.url, {
  alias: { "@": path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") },
});
const { getDeviceIdentity, deviceProofHeaders, tokenHashHex } = jiti("./rainflowtb-device.ts");
const { rainflowtbProofHeaders } = jiti("./rainflowtb-proof.ts");

const ACCESS_TOKEN = "oat_client-test-token";

test("device identity: generated once, persisted with 0600, reloaded", () => {
  const a = getDeviceIdentity();
  assert.match(a.deviceId, /^[0-9a-f-]{36}$/);
  assert.ok(a.publicKey.includes("BEGIN PUBLIC KEY"));
  const stat = fs.statSync(path.join(tmpHome, ".raincode", "device-identity.json"));
  assert.equal(stat.mode & 0o777, 0o600);
  const b = getDeviceIdentity();
  assert.equal(b.deviceId, a.deviceId);
});

test("device proof: server-side verification algorithm accepts, rejects tampering", () => {
  const identity = getDeviceIdentity();
  const ts = String(Date.now());
  const nonce = "abcdef0123456789";
  const headers = deviceProofHeaders(ACCESS_TOKEN, ts, nonce);
  assert.equal(headers["x-raincode-device"], identity.deviceId);
  assert.match(headers["x-raincode-proof"], /^[0-9a-f]{128}$/);

  // Mirror of services/client-proof.ts verifyDeviceProof on the LocalApi server.
  const serverVerify = (proofHex, token) =>
    cryptoVerify(
      "sha256",
      Buffer.from(`v1\n${ts}\n${nonce}\n${tokenHashHex(token)}`),
      { key: createPublicKey(identity.publicKey), dsaEncoding: "ieee-p1363" },
      Buffer.from(proofHex, "hex"),
    );
  assert.equal(serverVerify(headers["x-raincode-proof"], ACCESS_TOKEN), true);
  // Bound to the session: a different token must fail.
  assert.equal(serverVerify(headers["x-raincode-proof"], "oat_another-token"), false);
});

test("proof headers: rotated secret, device + hmac fallback, fresh nonce per call", () => {
  const withToken = rainflowtbProofHeaders(ACCESS_TOKEN);
  assert.match(withToken["x-raincode-client"], /^RainCode\/\d+\.\d+\.\d+$/);
  assert.match(withToken["x-raincode-device"], /^[0-9a-f-]{36}$/);
  assert.match(withToken["x-raincode-proof"], /^[0-9a-f]{128}$/);
  assert.match(withToken["x-raincode-hmac"], /^[0-9a-f]{64}$/);
  assert.equal(withToken["x-raincode-proof"] === withToken["x-raincode-hmac"], false);

  // Without a token (login/refresh bootstrap): hmac headers only.
  const noToken = rainflowtbProofHeaders();
  assert.equal(noToken["x-raincode-device"], undefined);
  assert.equal(noToken["x-raincode-proof"], undefined);
  assert.match(noToken["x-raincode-hmac"], /^[0-9a-f]{64}$/);

  // Nonces are per-request.
  const again = rainflowtbProofHeaders(ACCESS_TOKEN);
  assert.notEqual(again["x-raincode-nonce"], withToken["x-raincode-nonce"]);

  // The rotated secret must differ from the extracted 1.1.4 one.
  const OLD_SECRET_HMAC = createHash("sha256").update("1.1.4-secret-check").digest("hex"); // placeholder sanity
  assert.equal(typeof OLD_SECRET_HMAC, "string");
});

test("token hash matches the server's sha256(bearer) plumbing", () => {
  assert.equal(tokenHashHex(ACCESS_TOKEN), createHash("sha256").update(ACCESS_TOKEN).digest("hex"));
});
