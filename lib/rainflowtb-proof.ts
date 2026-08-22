/**
 * Official-client proof for the RAINFLOWTB channel (server-only).
 *
 * Two proof layers are emitted per request:
 *  1. Per-device ECDSA proof (lib/rainflowtb-device.ts) — the real gate. The
 *     private key is generated per device and never ships in the bundle.
 *  2. Legacy shared-secret HMAC (`x-raincode-hmac`) — rollout fallback only;
 *     the server stops honoring it once raincode_device_proof_required flips.
 *     The shared secret ships inside the bundle, so it cannot be hidden from
 *     a determined extractor; the chunked XOR masking below only raises the
 *     bar above "grep the bundle for a hex string". Keep it that way — do not
 *     add a second storage path. (Rotated in 1.2.0 after the 1.1.4 secret was
 *     extracted by repacked clients.)
 *
 * Imported by lib/rainflowtb-provider.ts, never by renderer code.
 */
import { createHmac, randomBytes } from "node:crypto";
import { getAppVersion } from "./app-version";
import { deviceProofHeaders } from "./rainflowtb-device";

// Masked secret material: chunk[i] ^ _m[(chunkIndex * 7 + i) % 32].
const _m = [104, 208, 197, 178, 67, 100, 192, 108, 149, 5, 123, 41, 212, 98, 89, 53, 42, 249, 180, 93, 27, 48, 46, 254, 156, 80, 104, 36, 166, 1, 59, 227];
const _c = [
  [12, 229, 242, 139, 118, 81, 242, 92, 172, 97, 78],
  [92, 172, 53, 25, 28, 226, 3, 109, 6, 26, 192],
  [96, 4, 72, 204, 134, 60, 47, 2, 23, 207, 164],
  [84, 74, 200, 248, 51, 90, 65, 158, 100, 89, 218],
  [197, 54, 9, 210, 90, 231, 247, 212, 37, 0, 242],
  [134, 37, 93, 248, 90, 161, 61, 75, 29],
];

let cachedSecret: string | null = null;

function proofSecret(): string {
  if (cachedSecret) return cachedSecret;
  cachedSecret = _c
    .map((chunk, ci) => String.fromCharCode(...chunk.map((v, i) => v ^ _m[(ci * 7 + i) % 32])))
    .join("");
  return cachedSecret;
}

/**
 * Fresh proof headers for one request. When the OAuth access token is known
 * (every authenticated call), the per-device ECDSA proof is included; the
 * legacy HMAC rides along as `x-raincode-hmac` for the rollout grace window.
 * Minted per request — the server accepts only a 120s skew and single-use
 * nonces, so these must never be cached across requests.
 */
export function rainflowtbProofHeaders(accessToken?: string): Record<string, string> {
  const ts = Date.now().toString();
  const nonce = randomBytes(12).toString("hex");
  const hmac = createHmac("sha256", proofSecret()).update(`v1\n${ts}\n${nonce}`).digest("hex");
  const headers: Record<string, string> = {
    "x-raincode-client": `RainCode/${getAppVersion()}`,
    "x-raincode-ts": ts,
    "x-raincode-nonce": nonce,
    "x-raincode-hmac": hmac,
  };
  if (accessToken) Object.assign(headers, deviceProofHeaders(accessToken, ts, nonce));
  return headers;
}
