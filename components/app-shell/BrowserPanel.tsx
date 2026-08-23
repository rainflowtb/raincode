"use client";

/**
 * Built-in browser workspace pane — owns the native WebContentsView
 * attach/detach/setBounds lifecycle for one viewId (active chat session, or
 * "scratch"). The native view paints above the DOM, so it is detached whenever
 * this pane is hidden or suspended (panel resize, file-viewer modal, settings).
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { ArrowLeft, ArrowRight, RotateCw, X } from "lucide-react";
import { useLocale } from "@/hooks/useLocale";
import { getDesktopBrowser, type BrowserRect, type BrowserState, type BrowserTabInfo } from "@/lib/desktop-browser";
import { Icon } from "../Icon";

const SCRATCH_VIEW_ID = "scratch";

export interface BrowserPanelProps {
  /** Active chat session id; null before any session is selected. */
  sessionId: string | null;
  /** Right panel open AND browser tab active. */
  visible: boolean;
  /** Temporarily covered by other UI (resize drag, viewer modal, settings). */
  suspended: boolean;
}

export function BrowserPanel({ sessionId, visible, suspended }: BrowserPanelProps) {
  const { t } = useLocale();
  // Preload bridge is fixed for the app's lifetime — resolve it once.
  const [browser] = useState(() => getDesktopBrowser());
  const baseViewId = sessionId ?? SCRATCH_VIEW_ID;
  // "main" is the base view; agent side tabs live at "<base>/<tab>".
  const [activeTab, setActiveTab] = useState("main");
  const viewId = activeTab === "main" ? baseViewId : `${baseViewId}/${activeTab}`;
  const [tabs, setTabs] = useState<BrowserTabInfo[]>([]);
  const [state, setState] = useState<BrowserState | null>(null);
  const [urlInput, setUrlInput] = useState("");
  const [urlFocused, setUrlFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const placeholderRef = useRef<HTMLDivElement | null>(null);

  const attached = Boolean(browser) && visible && !suspended;

  // Attach/detach lifecycle: one owner per viewId. The native view sits above
  // the DOM, so any hidden/suspended transition must detach it here.
  useEffect(() => {
    if (!browser || !attached) return;
    const el = placeholderRef.current;
    if (!el) return;
    let disposed = false;

    const toRect = (): BrowserRect => {
      const r = el.getBoundingClientRect();
      // CSS px == DIPs; the main process applies no scaling (see normalizeRect).
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };

    // The native view ignores CSS clipping, so round its corners natively.
    // The radius comes from the --radius-lg token — read, never hardcoded.
    const radius = Number.parseInt(getComputedStyle(el).getPropertyValue("--radius-lg"), 10) || 0;

    setError(null);
    browser
      .attach(viewId, toRect(), radius)
      .then((s) => {
        if (!disposed) setState(s);
      })
      .catch((e: unknown) => {
        if (!disposed) setError(e instanceof Error ? e.message : String(e));
      });

    const pushBounds = () => {
      void browser.setBounds(toRect());
    };
    const observer = new ResizeObserver(pushBounds);
    observer.observe(el);
    window.addEventListener("resize", pushBounds);

    return () => {
      disposed = true;
      observer.disconnect();
      window.removeEventListener("resize", pushBounds);
      void browser.detach();
    };
  }, [browser, attached, viewId]);

  // A different session owns a different tab tree — fall back to its main tab.
  useEffect(() => {
    setActiveTab("main");
    setTabs([]);
    setState(null);
  }, [baseViewId]);

  const refreshTabs = useCallback(() => {
    if (!browser) return;
    void browser.list(baseViewId).then(setTabs).catch(() => {});
  }, [browser, baseViewId]);

  // Native-side state pushes (navigation, title, loading). Any event in this
  // session's tab tree refreshes the tab list (debounced); events for the
  // attached tab also drive the toolbar state.
  useEffect(() => {
    if (!browser) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    refreshTabs();
    const unsubscribe = browser.onStateChange((s) => {
      if (s.viewId !== baseViewId && !s.viewId.startsWith(`${baseViewId}/`)) return;
      if (s.viewId === viewId) setState(s);
      clearTimeout(timer);
      timer = setTimeout(refreshTabs, 150);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [browser, baseViewId, viewId, refreshTabs]);

  const closeTab = useCallback((tab: string) => {
    if (!browser) return;
    void browser
      .close(tab === "main" ? baseViewId : `${baseViewId}/${tab}`)
      .then(refreshTabs)
      .catch(() => {});
  }, [browser, baseViewId, refreshTabs]);

  // The attached tab vanished from its tree (session views were destroyed
  // under an idle timeout) — never cling to a dead view.
  useEffect(() => {
    if (activeTab !== "main" && tabs.length > 0 && !tabs.some((t) => t.tab === activeTab)) {
      setActiveTab("main");
    }
  }, [tabs, activeTab]);

  // Follow navigations in the URL bar unless the user is editing it.
  useEffect(() => {
    if (!urlFocused) setUrlInput(state?.url ?? "");
  }, [state?.url, urlFocused]);

  const navigate = useCallback(() => {
    if (!browser) return;
    const url = urlInput.trim();
    if (!url) return;
    setError(null);
    browser
      .navigate(viewId, url)
      .then((s) => setState(s))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [browser, viewId, urlInput]);

  if (!browser) {
    return (
      <div style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px 14px",
        color: "var(--text-dim)",
        fontSize: 12,
        textAlign: "center",
      }}>
        {t("browser.desktopOnly")}
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 4, height: 32, padding: "0 8px", flexShrink: 0 }}>
        <button
          type="button"
          className="icon-btn"
          style={{ "--icon-btn-size": "24px" } as CSSProperties}
          onClick={() => void browser.goBack(viewId)}
          disabled={!state?.canGoBack}
          title={t("common.back")}
          aria-label={t("common.back")}
        >
          <Icon icon={ArrowLeft} size={13} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          className="icon-btn"
          style={{ "--icon-btn-size": "24px" } as CSSProperties}
          onClick={() => void browser.goForward(viewId)}
          disabled={!state?.canGoForward}
          title={t("common.forward")}
          aria-label={t("common.forward")}
        >
          <Icon icon={ArrowRight} size={13} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          className="icon-btn"
          style={{ "--icon-btn-size": "24px" } as CSSProperties}
          onClick={() => void browser.reload(viewId)}
          disabled={!state?.url}
          title={t("common.refresh")}
          aria-label={t("common.refresh")}
        >
          <span className={state?.loading ? "session-running-spin" : undefined} style={{ display: "inline-flex" }}>
            <Icon icon={RotateCw} size={13} strokeWidth={1.8} />
          </span>
        </button>
        <input
          type="text"
          className="input-base input-mono"
          style={{ flex: 1, minWidth: 0, height: 24, padding: "3px 8px" }}
          value={urlInput}
          placeholder={t("browser.urlPlaceholder")}
          aria-label={t("browser.urlPlaceholder")}
          onChange={(e) => setUrlInput(e.target.value)}
          onFocus={() => setUrlFocused(true)}
          onBlur={() => setUrlFocused(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              navigate();
            }
          }}
          spellCheck={false}
        />
      </div>
      {error && (
        <div style={{ padding: "2px 10px 4px", fontSize: 11, color: "var(--destructive)", flexShrink: 0 }}>
          {error}
        </div>
      )}
      {tabs.length > 1 && (
        <div style={{ display: "flex", gap: 4, padding: "0 8px 6px", overflowX: "auto", flexShrink: 0 }}>
          {tabs.map((tab) => (
            <div
              key={tab.tab}
              style={{
                display: "flex",
                alignItems: "center",
                flexShrink: 0,
                borderRadius: "var(--radius-pill)",
                background: tab.tab === activeTab ? "var(--bg-selected)" : "transparent",
              }}
            >
              <button
                type="button"
                onClick={() => setActiveTab(tab.tab)}
                title={tab.url || tab.title || tab.tab}
                style={{
                  fontSize: 11,
                  padding: "2px 4px 2px 10px",
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  maxWidth: 160,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  color: tab.tab === activeTab ? "var(--text)" : "var(--text-muted)",
                }}
              >
                {tab.tab === "main" ? t("browser.mainTab") : tab.tab}
              </button>
              <button
                type="button"
                className="icon-btn"
                style={{ "--icon-btn-size": "18px" } as CSSProperties}
                onClick={() => closeTab(tab.tab)}
                title={t("common.close")}
                aria-label={t("common.close")}
              >
                <Icon icon={X} size={10} strokeWidth={2} />
              </button>
            </div>
          ))}
        </div>
      )}
      {/* The viewport is an inset card: padding keeps the native view clear of
          the shell-panel's rounded corners; the view itself is rounded natively
          (see the attach effect). The rect is measured on the inner div. */}
      <div style={{ position: "relative", flex: 1, minHeight: 0, padding: "4px 8px 8px" }}>
        <div ref={placeholderRef} style={{ width: "100%", height: "100%" }} />
        {!state?.url && (
          <div style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "16px 14px",
            color: "var(--text-dim)",
            fontSize: 12,
            textAlign: "center",
          }}>
            {t("browser.emptyHint")}
          </div>
        )}
      </div>
    </div>
  );
}
