/**
 * Desktop built-in browser bridge owner — typed accessor over window.raincodeDesktop.browser.
 */

export type BrowserRect = { x: number; y: number; width: number; height: number };

export type BrowserState = {
  viewId: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
};

export type BrowserTabInfo = { tab: string; url: string; title: string };

export type DesktopBrowser = {
  attach(viewId: string, rect: BrowserRect, radius?: number): Promise<BrowserState>;
  detach(): Promise<void>;
  setBounds(rect: BrowserRect): Promise<void>;
  navigate(viewId: string, url: string): Promise<BrowserState>;
  goBack(viewId: string): Promise<void>;
  goForward(viewId: string): Promise<void>;
  reload(viewId: string): Promise<void>;
  getState(viewId: string): Promise<BrowserState>;
  /** Tabs of one session tree: the base viewId's own tab is named "main". */
  list(viewId: string): Promise<BrowserTabInfo[]>;
  /** Close one tab (exact viewId). */
  close(viewId: string): Promise<void>;
  onStateChange(cb: (state: BrowserState) => void): () => void;
};

/** Undefined outside the desktop client (plain web dev has no preload bridge). */
export function getDesktopBrowser(): DesktopBrowser | undefined {
  if (typeof window === "undefined") return undefined;
  const desktop = window.raincodeDesktop as { browser?: DesktopBrowser } | undefined;
  return desktop?.browser;
}
