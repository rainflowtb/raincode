/**
 * Desktop LAN-access bridge owner — typed accessor over window.raincodeDesktop.lan*.
 */

export type LanServerState = {
  running: boolean;
  port: number;
  urls: string[];
  error: string | null;
};

export type DesktopLanBridge = {
  lanApply: () => Promise<LanServerState>;
  lanGetState: () => Promise<LanServerState>;
};

/** Undefined outside the desktop client (plain web / LAN browsers have no preload bridge). */
export function getDesktopLan(): DesktopLanBridge | undefined {
  if (typeof window === "undefined") return undefined;
  const { lanApply, lanGetState } = (window.raincodeDesktop ?? {}) as Partial<DesktopLanBridge>;
  if (typeof lanApply !== "function" || typeof lanGetState !== "function") return undefined;
  return { lanApply, lanGetState };
}
