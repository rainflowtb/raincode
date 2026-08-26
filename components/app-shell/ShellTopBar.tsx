"use client";

/** Shell top bar: brand glyph + full sidebar toggle + level-1 pill nav +
    session chrome, sitting openly on the canvas. While settings is showing, only
    brand + pills remain — session chrome belongs to the chat surface. */
import { Menu, PanelLeft, PanelRight } from "lucide-react";
import { useLocale } from "@/hooks/useLocale";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { SessionInfo } from "@/lib/types";
import { formatShortcut, modKeyLabel } from "@/lib/keyboard";
import { Icon } from "../Icon";
import { BrandGlyph } from "./BrandMark";
import { TopBarSessionTitle } from "../TopBarSessionTitle";
import { TopBarChromeWidgets } from "../TopBarChromeWidgets";
import { WindowControls } from "../WindowControls";

interface ShellTopBarProps {
  sidebarOpen: boolean;
  /** Reserve the macOS traffic-lights pad while the in-shell settings page shows. */
  reserveTrafficLights?: boolean;
  onToggleSidebar: () => void;
  settingsOpen: boolean;
  onOpenChat: () => void;
  onOpenSettings: () => void;
  onWarmSettings: () => void;
  session: SessionInfo | null;
  showChat: boolean;
  appUpdate: { releaseUrl: string; latestVersion: string } | null;
  rightPanelOpen: boolean;
  onToggleRightPanel: () => void;
}

export function ShellTopBar({
  sidebarOpen,
  reserveTrafficLights,
  onToggleSidebar,
  settingsOpen,
  onOpenChat,
  onOpenSettings,
  onWarmSettings,
  session,
  showChat,
  appUpdate,
  rightPanelOpen,
  onToggleRightPanel,
}: ShellTopBarProps) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  return (
    <div
      className="app-topbar titlebar-drag desktop-top-chrome"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexShrink: 0,
        height: "var(--titlebar-height)",
        padding: "0 8px",
        background: "transparent",
        overflow: "hidden",
        minWidth: 0,
      }}
    >
      {/* When the sidebar is hidden on macOS desktop, leave room for traffic
          lights. --traffic-lights-pad is 0 on web / win / linux. On mobile the
          sidebar is a fixed overlay drawer, so opening it must NOT remove the
          pad — otherwise the left cluster slides left under the traffic
          lights on a narrow macOS window. */}
      {(!sidebarOpen || reserveTrafficLights || isMobile) && <div className="traffic-lights-spacer titlebar-drag" aria-hidden />}

      {/* Brand glyph shares one slot with the full sidebar toggle: glyph at
          rest, swap to the toggle button on hover / keyboard focus. */}
      <div className="titlebar-no-drag" style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        {!settingsOpen ? (
          <div className="brand-toggle-slot">
            <span className="brand-toggle-glyph" aria-hidden>
              <BrandGlyph />
            </span>
            <button
              type="button"
              className="chrome-btn is-icon brand-toggle-btn"
              onClick={onToggleSidebar}
              title={`${sidebarOpen ? t("shell.hideSidebar") : t("shell.showSidebar")} (${formatShortcut(modKeyLabel(), "B")})`}
              aria-label={sidebarOpen ? t("shell.hideSidebar") : t("shell.showSidebar")}
            >
              {sidebarOpen ? (
                <Icon icon={PanelLeft} size={16} strokeWidth={1.75} />
              ) : (
                <Icon icon={Menu} size={18} strokeWidth={1.75} />
              )}
            </button>
          </div>
        ) : (
          /* Settings has no sidebar to toggle, but keeps the same 32px slot so
             the nav pills don't shift left when switching views. Plain glyph —
             NOT .brand-toggle-glyph, which (hover: none) hides in mobile.css. */
          <div className="brand-toggle-slot" aria-hidden>
            <BrandGlyph />
          </div>
        )}
        <nav
          aria-label={t("shell.settings")}
          style={{ display: "flex", alignItems: "center", gap: 2 }}
        >
          <button
            type="button"
            className={`shell-nav-pill${!settingsOpen ? " is-active" : ""}`}
            aria-current={!settingsOpen ? "page" : undefined}
            onClick={onOpenChat}
          >
            {t("shell.navChat")}
          </button>
          <button
            type="button"
            className={`shell-nav-pill${settingsOpen ? " is-active" : ""}`}
            aria-current={settingsOpen ? "page" : undefined}
            onClick={onOpenSettings}
            onPointerEnter={onWarmSettings}
            title={`${t("shell.settings")} (${formatShortcut(modKeyLabel(), ",")})`}
          >
            {t("shell.settings")}
          </button>
        </nav>
      </div>

      {/* Middle: drag + session title + status widgets — chat-only chrome,
          hidden while settings is showing */}
      <div className="app-topbar-middle titlebar-drag" style={{ alignItems: "center" }}>
        {!settingsOpen && (
          <TopBarSessionTitle
            session={session}
            isNewSession={session === null && showChat}
          />
        )}
        {appUpdate && (
          <button
            type="button"
            className="chrome-btn app-update-chip titlebar-no-drag"
            onClick={() => {
              window.open(appUpdate.releaseUrl, "_blank", "noopener,noreferrer");
            }}
            title={t("shell.updateAvailableTitle", { version: appUpdate.latestVersion })}
            aria-label={t("shell.updateAvailableTitle", { version: appUpdate.latestVersion })}
          >
            <span className="app-update-dot" aria-hidden />
            <span>{t("shell.updateAvailable", { version: appUpdate.latestVersion })}</span>
          </button>
        )}
        <div className="titlebar-drag" style={{ flex: 1, minWidth: 8, height: "100%" }} aria-hidden />
        {showChat && !settingsOpen && (
          <div className="chrome-cluster titlebar-no-drag app-topbar-actions">
            {/* Todo + subagents — quiet status capsules (own popovers) */}
            <TopBarChromeWidgets parentSessionId={session?.id ?? null} />
          </div>
        )}
      </div>

      {/* Trailing: file panel toggle — chat-only (panel is hidden in settings) */}
      {!settingsOpen && (
        <div className="app-topbar-trailing titlebar-no-drag" style={{ alignItems: "center" }}>
          <button
            type="button"
            className={`chrome-btn is-icon${rightPanelOpen ? " is-active" : ""}`}
            onClick={onToggleRightPanel}
            title={`${rightPanelOpen ? t("shell.hideFilePanel") : t("shell.showFilePanel")} (${formatShortcut(modKeyLabel(), "\\")})`}
            aria-label={rightPanelOpen ? t("shell.hideFilePanel") : t("shell.showFilePanel")}
            style={{ flexShrink: 0 }}
          >
            <Icon icon={PanelRight} size={16} strokeWidth={1.75} />
          </button>
        </div>
      )}
      {/* Custom Windows/Linux caption buttons — only when this bar is rightmost.
          Right panel hosts its own, but it is hidden while settings is showing. */}
      {(!rightPanelOpen || settingsOpen) && <WindowControls />}
    </div>
  );
}
