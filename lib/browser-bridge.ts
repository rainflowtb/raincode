/**
 * Reverse-IPC client: lets agent tools in the heavy runtime drive the Electron
 * main process's browser view pool over the existing child-process channel
 * ({ t:"browser" } → { t:"browser-res" }); module-scope pending map, 45s timeout.
 */

type BrowserReply = {
  t?: string;
  id?: string;
  ok?: boolean;
  data?: unknown;
  error?: string;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

const REQUEST_TIMEOUT_MS = 45_000;

const pending = new Map<string, PendingRequest>();
let counter = 0;
let listenerInstalled = false;

function ensureReplyListener(): void {
  if (listenerInstalled) return;
  listenerInstalled = true;
  process.on("message", (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const msg = message as BrowserReply;
    if (msg.t !== "browser-res" || typeof msg.id !== "string") return;
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    clearTimeout(waiter.timer);
    if (msg.ok) waiter.resolve(msg.data);
    else waiter.reject(new Error(msg.error || "browser request failed"));
  });
}

/** True only inside the Electron desktop runtime (main.js sets RAINCODE_DESKTOP=1). */
export function isBrowserBridgeAvailable(): boolean {
  return process.env.RAINCODE_DESKTOP === "1" && typeof process.send === "function";
}

/** Send one browser action to the main process; rejects on error reply or timeout. */
export function browserMainRequest<T>(action: string, params: Record<string, unknown>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const send = process.send?.bind(process);
    if (process.env.RAINCODE_DESKTOP !== "1" || typeof send !== "function") {
      reject(new Error("Browser is only available in the RainCode desktop app."));
      return;
    }
    ensureReplyListener();
    const id = `br${++counter}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`browser ${action} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
    try {
      send({ t: "browser", id, action, params });
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
