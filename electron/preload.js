"use strict";

const { contextBridge, ipcRenderer } = require("electron");

/**
 * `/api` transport for the renderer. The UI is served locally by the main
 * process, so it has no HTTP origin to fetch from — lib/api-transport.ts calls
 * through here instead.
 */
contextBridge.exposeInMainWorld("raincodeApi", {
  request: (payload) => ipcRenderer.invoke("raincode-api:request", payload),
  abort: (requestId) => ipcRenderer.send("raincode-api:abort", { requestId }),
  streamOpen: (payload) => ipcRenderer.send("raincode-api:stream-open", payload),
  streamClose: (streamId) => ipcRenderer.send("raincode-api:stream-close", { streamId }),
  onStreamEvent: (callback) => {
    const handler = (_event, message) => callback(message);
    ipcRenderer.on("raincode-api:stream", handler);
    return () => ipcRenderer.removeListener("raincode-api:stream", handler);
  },
});

contextBridge.exposeInMainWorld("raincodeDesktop", {
  selectDirectory: () => ipcRenderer.invoke("raincode-desktop:select-directory"),
  setTheme: (theme) => ipcRenderer.invoke("raincode-desktop:set-theme", theme),
  windowMinimize: () => ipcRenderer.invoke("raincode-desktop:window-minimize"),
  windowMaximizeToggle: () => ipcRenderer.invoke("raincode-desktop:window-maximize-toggle"),
  windowClose: () => ipcRenderer.invoke("raincode-desktop:window-close"),
  windowIsMaximized: () => ipcRenderer.invoke("raincode-desktop:window-is-maximized"),
  windowState: () => ipcRenderer.invoke("raincode-desktop:window-state"),
  notify: (payload) => ipcRenderer.invoke("raincode-desktop:notify", payload),
  getWebSettingsPath: () => ipcRenderer.invoke("raincode-desktop:get-web-settings-path"),
  /**
   * Cold-start handshake: AppShell calls this after first paint so the main
   * process can dismiss the splash without flashing a white React mount frame.
   */
  notifyUiReady: () => {
    try {
      ipcRenderer.send("raincode-desktop:ui-ready");
    } catch {
      // ignore
    }
  },
  onWindowStateChange: (callback) => {
    if (typeof callback !== "function") return () => {};
    const handler = (_event, state) => callback(state);
    ipcRenderer.on("raincode-desktop:window-state", handler);
    return () => {
      ipcRenderer.removeListener("raincode-desktop:window-state", handler);
    };
  },
  /**
   * Built-in browser panel. Views are WebContentsView instances owned by the
   * main process; rect is CSS px (== DIPs, no scaling). State pushes arrive on
   * "raincode-desktop:browser-state".
   */
  browser: {
    attach: (viewId, rect, radius) => ipcRenderer.invoke("raincode-desktop:browser", { op: "attach", viewId, rect, radius }),
    detach: () => ipcRenderer.invoke("raincode-desktop:browser", { op: "detach" }),
    setBounds: (rect) => ipcRenderer.invoke("raincode-desktop:browser", { op: "setBounds", rect }),
    navigate: (viewId, url) => ipcRenderer.invoke("raincode-desktop:browser", { op: "navigate", viewId, url }),
    goBack: (viewId) => ipcRenderer.invoke("raincode-desktop:browser", { op: "goBack", viewId }),
    goForward: (viewId) => ipcRenderer.invoke("raincode-desktop:browser", { op: "goForward", viewId }),
    reload: (viewId) => ipcRenderer.invoke("raincode-desktop:browser", { op: "reload", viewId }),
    getState: (viewId) => ipcRenderer.invoke("raincode-desktop:browser", { op: "getState", viewId }),
    list: (viewId) => ipcRenderer.invoke("raincode-desktop:browser", { op: "list", viewId }),
    close: (viewId) => ipcRenderer.invoke("raincode-desktop:browser", { op: "close", viewId }),
    onStateChange: (callback) => {
      if (typeof callback !== "function") return () => {};
      const handler = (_event, state) => callback(state);
      ipcRenderer.on("raincode-desktop:browser-state", handler);
      return () => {
        ipcRenderer.removeListener("raincode-desktop:browser-state", handler);
      };
    },
  },
  isDesktop: true,
  platform: process.platform,
});
