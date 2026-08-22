/**
 * Per-device client identity for the RAINFLOWTB channel (server-only).
 *
 * The old scheme signed requests with a shared secret baked into the bundle —
 * and that secret has been extracted from released builds by repacked clients
 * ("mimocode" et al). This module replaces it with a per-device ECDSA P-256
 * keypair generated on first run: the private key never leaves this machine
 * (stored in ~/.raincode/device-identity.json, mode 0600), the public key is
 * registered against the user's account (POST /oauth/device, OAuth-token
 * auth), and every request is signed over
 * `v1\n<ts>\n<nonce>\n<sha256hex(accessToken)>` — binding the proof to this
 * device AND this login session. Nothing shared ships in the bundle, so
 * package extraction yields nothing.
 */
import { createHash, createHmac, generateKeyPairSync, randomUUID, sign as cryptoSign } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, homedir, hostname, platform } from "node:os";
import { join } from "node:path";
import { RAINFLOWTB_BASE_URL } from "./rainflowtb-constants";

const IDENTITY_DIR = join(homedir(), ".raincode");
const IDENTITY_PATH = join(IDENTITY_DIR, "device-identity.json");

interface DeviceIdentity {
  deviceId: string;
  publicKey: string;
  privateKey: string;
  /** sha256 of the access token the public key was last registered with. */
  registeredFor?: string;
}

let cachedIdentity: DeviceIdentity | null = null;

function generateIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    deviceId: randomUUID(),
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function saveIdentity(identity: DeviceIdentity): void {
  mkdirSync(IDENTITY_DIR, { recursive: true });
  writeFileSync(IDENTITY_PATH, JSON.stringify(identity, null, 2));
  try {
    chmodSync(IDENTITY_PATH, 0o600);
  } catch {
    // Windows ACLs don't map to POSIX modes; the file still sits in the
    // user's profile dir, which is the meaningful boundary there.
  }
}

/** Load (or lazily create) this device's long-lived identity. */
export function getDeviceIdentity(): DeviceIdentity {
  if (cachedIdentity) return cachedIdentity;
  try {
    if (existsSync(IDENTITY_PATH)) {
      const parsed = JSON.parse(readFileSync(IDENTITY_PATH, "utf8")) as DeviceIdentity;
      if (parsed.deviceId && parsed.publicKey && parsed.privateKey) {
        cachedIdentity = parsed;
        return parsed;
      }
    }
  } catch {
    // Corrupted file — fall through and regenerate.
  }
  const identity = generateIdentity();
  saveIdentity(identity);
  cachedIdentity = identity;
  return identity;
}

export function tokenHashHex(accessToken: string): string {
  return createHash("sha256").update(accessToken).digest("hex");
}

/**
 * Device-proof headers for one request. `ts`/`nonce` come from the caller so
 * a single (ts, nonce) pair covers both the ECDSA proof and the legacy HMAC
 * fallback header.
 */
export function deviceProofHeaders(accessToken: string, ts: string, nonce: string): Record<string, string> {
  const identity = getDeviceIdentity();
  const proof = cryptoSign(
    "sha256",
    Buffer.from(`v1\n${ts}\n${nonce}\n${tokenHashHex(accessToken)}`),
    { key: identity.privateKey, dsaEncoding: "ieee-p1363" },
  ).toString("hex");
  return {
    "x-raincode-device": identity.deviceId,
    "x-raincode-proof": proof,
  };
}

/**
 * Register this device's public key with the site (idempotent). Retried on
 * every login/refresh until it succeeds; a failure only means restricted
 * models stay gated until the next attempt.
 */
export async function ensureDeviceRegistered(accessToken: string, signal?: AbortSignal): Promise<void> {
  const identity = getDeviceIdentity();
  const tokenHash = tokenHashHex(accessToken);
  if (identity.registeredFor === tokenHash) return;
  const res = await fetch(`${RAINFLOWTB_BASE_URL}/oauth/device`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      device_id: identity.deviceId,
      public_key: identity.publicKey,
      name: `${hostname()} (${platform()}/${arch()})`,
    }),
    cache: "no-store",
    signal: signal ?? null,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`RAINFLOWTB device registration failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  identity.registeredFor = tokenHash;
  saveIdentity(identity);
}
