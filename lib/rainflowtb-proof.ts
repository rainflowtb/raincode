/**
 * Official-client proof for the RAINFLOWTB channel: signs every request with
 * an HMAC over a timestamp + nonce so the site can gate zero-priced models to
 * the RainCode desktop client. Server-only — imported by
 * lib/rainflowtb-provider.ts, never by renderer code.
 *
 * The shared secret ships inside the bundle, so it cannot be hidden from a
 * determined extractor; the chunked XOR masking below only raises the bar
 * above "grep the bundle for a hex string". Keep it that way — do not add a
 * second storage path.
 */
import { createHmac, randomBytes } from "node:crypto";
import { getAppVersion } from "./app-version";

// Masked secret material: chunk[i] ^ _m[(chunkIndex * 7 + i) % 32].
const _m = [104, 208, 197, 178, 67, 100, 192, 108, 149, 5, 123, 41, 212, 98, 89, 53, 42, 249, 180, 93, 27, 48, 46, 254, 156, 80, 104, 36, 166, 1, 59, 227];
const _c = [
  [13, 226, 166, 135, 115, 0, 240, 93, 246, 61, 73],
  [92, 172, 55, 31, 28, 228, 4, 63, 12, 75, 206],
  [63, 83, 19, 155, 134, 60, 126, 82, 28, 202, 172],
  [4, 25, 200, 249, 54, 94, 65, 144, 53, 88, 135],
  [197, 54, 13, 128, 10, 233, 245, 131, 119, 2, 166],
  [131, 112, 7, 247, 92, 240, 61, 25, 28],
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
 * Fresh proof headers for one request. The server accepts a 10-minute skew,
 * so these must be minted per auth resolution rather than cached for a whole
 * app run.
 */
export function rainflowtbProofHeaders(): Record<string, string> {
  const ts = Date.now().toString();
  const nonce = randomBytes(12).toString("hex");
  const proof = createHmac("sha256", proofSecret()).update(`v1\n${ts}\n${nonce}`).digest("hex");
  return {
    "x-raincode-client": `RainCode/${getAppVersion()}`,
    "x-raincode-ts": ts,
    "x-raincode-nonce": nonce,
    "x-raincode-proof": proof,
  };
}
