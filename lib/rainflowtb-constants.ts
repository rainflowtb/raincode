/**
 * Wire constants for the RAINFLOWTB subscription provider (Pi-Web).
 * Server-only, shared with lib/rainflowtb-provider.ts.
 *
 * RAINFLOWTB runs the LocalApi OAuth broker service (see LocalApi repo,
 * docs/pi-web-oauth.md) on two domains: api.rainflowtb.cn (国内) and
 * api.rainflowtb.com (海外). The user picks the domain at login time and the
 * choice is stored on the OAuth credential — every URL derives from
 * (domain, channel). Override the instance URL with RAINFLOWTB_BASE_URL when
 * testing against a staging instance (forces the given URL for all domains).
 */

export const RAINFLOWTB_PROVIDER_ID = "rainflowtb";
export const RAINFLOWTB_DISPLAY_NAME = "RainFlow TB";

/** The two broker domains the user chooses between at login. */
export type RainflowtbDomain = "cn" | "com";
export const RAINFLOWTB_DOMAINS: Record<RainflowtbDomain, string> = {
  cn: "https://api.rainflowtb.cn",
  com: "https://api.rainflowtb.com",
};

const ENV_OVERRIDE = (process.env.RAINFLOWTB_BASE_URL || "").replace(/\/+$/, "");

/** Broker base URL for a domain; env override wins (staging), default is com. */
export function rainflowtbBaseUrl(domain?: RainflowtbDomain): string {
  return ENV_OVERRIDE || RAINFLOWTB_DOMAINS[domain ?? "com"];
}

/** All broker endpoint URLs derived from one base — one owner for the wire map. */
export interface RainflowtbUrls {
  /** Wallet channel: OpenAI-compatible proxy, billed from the wallet balance. */
  wallet: string;
  /** Subscription channel: same proxy shape, gated by the Coding Plan. */
  coding: string;
  login: string;
  check: string;
  token: string;
  refresh: string;
  device: string;
}

export function rainflowtbUrls(domain?: RainflowtbDomain): RainflowtbUrls {
  const base = rainflowtbBaseUrl(domain);
  return {
    wallet: `${base}/v1`,
    coding: `${base}/coding/v1`,
    login: `${base}/oauth/login`,
    check: `${base}/oauth/check`,
    token: `${base}/oauth/token`,
    refresh: `${base}/oauth/refresh`,
    device: `${base}/oauth/device`,
  };
}

/**
 * Name shown on the broker's consent page ("X 请求访问你的账号").
 * Self-declared display string; the broker falls back to "Pi-Web" when absent.
 */
export const RAINFLOWTB_CLIENT_NAME = "RainCode";
