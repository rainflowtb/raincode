"use client";

import { useState, useCallback, useRef, useEffect, useLayoutEffect, useSyncExternalStore } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  CircleGauge,
  FileText,
  Folder,
  Globe,
  History,
  Plus,
  ShieldAlert,
  Terminal,
  Upload,
  X,
} from "lucide-react";
import { useGlobalKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
// Sidebar is always on first paint — keep it static so cold start never shows a
// blank panel while a dynamic chunk downloads (that looked like a broken UI).
import { SessionSidebar } from "./SessionSidebar";
import { FileExplorer, type FileExplorerHandle } from "./FileExplorer";
import { FileViewerModal, type ViewerFileTarget } from "./FileViewerModal";
import { GitHistory } from "./GitHistory";
import { hydrateAppearanceFromServer } from "@/lib/appearance-store";
import { SessionInspectDialogs } from "./session-inspect/SessionInspectDialogs";
import { ChildChatPane } from "./chat-window/ChildChatPane";
import { useLocale } from "@/hooks/useLocale";
import { useIsMobile } from "@/hooks/useIsMobile";
import { getFileName } from "@/lib/file-paths";
import { buildAtMentionText, buildFileAtMentionsText, buildFileLineMentionText } from "@/lib/file-fuzzy";
import { getInitialNavigation } from "@/lib/initial-navigation";
import type { SessionInfo, SessionTreeNode } from "@/lib/types";
import type { ChatInputHandle } from "@/lib/chat-input-types";
import { ContextTabBadge } from "./ContextTabBadge";
import { ProjectTrustDialog } from "./ProjectTrustDialog";
import { WindowControls } from "./WindowControls";
import { ShellTopBar } from "./app-shell/ShellTopBar";
import { getSessionStatsMetric, setSessionStatsMetric } from "@/lib/session-metrics-store";
import { closeChildTranscript, useChildTranscript } from "@/lib/child-transcript-store";
import { ShortcutsHelpDialog } from "./ShortcutsHelpDialog";
import { getAppUpdateInfo, startAppUpdateAutoCheck, subscribeAppUpdate } from "@/lib/app-update-store";
import type { ProjectTrustStatus, SkillInfo } from "@/lib/api-types";
import { setDraft } from "@/lib/draft-store";
import { invalidateUsage } from "./UsagePanel";
import { Icon } from "./Icon";

import {
  BrowserPanel,
  ChatWindow,
  ContextPanel,
  GitPanel,
  SettingsPage,
  TerminalPanel,
} from "./app-shell/lazy-panels";
import {
  EXPLORER_REFRESH_DEBOUNCE_MS,
  RIGHT_PANEL_DEFAULT,
  RIGHT_PANEL_MAX,
  RIGHT_PANEL_MIN,
  RIGHT_PANEL_WIDTH_KEY,
  SESSION_REFRESH_DEBOUNCE_MS,
  SIDEBAR_MAX,
  SIDEBAR_MAX_VIEWPORT_FRACTION,
  SIDEBAR_MIN,
  SIDEBAR_WIDTH_KEY,
} from "./app-shell/app-shell-constants";
import { ShellStyles } from "./app-shell/ShellStyles";
import { WORKSPACE_TABS } from "./app-shell/terminal-tabs";
import { useAppShellTerminal } from "@/hooks/useAppShellTerminal";
import { usePersistedPanelWidth } from "@/hooks/usePersistedPanelWidth";
import { apiFetch } from "@/lib/api-transport";
import { subscribeWorkspaceFilesChanged } from "@/lib/workspace-change-notify";
import { initOverlayScrollbars } from "@/lib/overlay-scrollbars";


export function AppShell() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [initialNavigation] = useState(() => getInitialNavigation(searchParams));
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const [selectedSession, setSelectedSession] = useState<SessionInfo | null>(null);
  const childView = useChildTranscript();
  const childOpen = Boolean(childView && selectedSession && childView.parentSessionId === selectedSession.id);
  // When user clicks +, we only store the cwd — no fake session id
  const [newSessionCwd, setNewSessionCwd] = useState<string | null>(null);
  const [activeCwd, setActiveCwd] = useState<string | null>(null);
  const [initialCwdStatus, setInitialCwdStatus] = useState<"idle" | "validating" | "ready" | "error">(
    () => initialNavigation.requestedCwd ? "validating" : "idle",
  );
  const [initialCwdError, setInitialCwdError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  // Force-remount epoch for ChatWindow (fork/trust/project switch). Session
  // identity is the primary key — re-selecting the same id must NOT bump this.
  const [sessionKey, setSessionKey] = useState(0);
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Once true, SettingsPage stays mounted (hidden when closed) so reopening is
  // instant and its state survives. Flipped on first open, hover, or idle.
  const [settingsWarm, setSettingsWarm] = useState(false);
  const [shortcutsHelpOpen, setShortcutsHelpOpen] = useState(false);
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0);
  const handleModelsChanged = useCallback(() => {
    setModelsRefreshKey((k) => k + 1);
  }, []);
  const appUpdate = useSyncExternalStore(subscribeAppUpdate, getAppUpdateInfo, () => null);

  // Background update check when Settings → auto-check is enabled.
  useEffect(() => {
    startAppUpdateAutoCheck({ delayMs: 8_000 });
  }, []);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileSidebarReady, setMobileSidebarReady] = useState(false);
  // On mobile the sidebar is an overlay drawer; hide it by default so the chat
  // is visible on load. Runs once the breakpoint resolves after hydration.
  useEffect(() => {
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);
  useEffect(() => {
    setMobileSidebarReady(true);
  }, []);
  useEffect(() => {
    hydrateAppearanceFromServer();
  }, []);
  // Warm-mount the lazily-loaded SettingsPage (hidden) once the shell is idle:
  // the chunk loads AND the component mounts + fetches its data in the
  // background, so the first visible open is instant — no blank flash while
  // the chunk compiles/loads.
  useEffect(() => {
    if (typeof requestIdleCallback === "function") {
      const idleId = requestIdleCallback(() => setSettingsWarm(true), { timeout: 5000 });
      return () => cancelIdleCallback(idleId);
    }
    const timer = window.setTimeout(() => setSettingsWarm(true), 3000);
    return () => window.clearTimeout(timer);
  }, []);
  // Electron immersive chrome: mark html so CSS can pad under traffic lights / enable drag.
  // Also toggle raincode-desktop-fullscreen so macOS can drop --traffic-lights-pad when the
  // system chrome no longer occupies the top-left (enter/leave-full-screen).
  useEffect(() => {
    const desktop = typeof window !== "undefined" ? window.raincodeDesktop : undefined;
    if (!desktop?.isDesktop) return;
    const root = document.documentElement;
    const platformClass =
      desktop.platform === "darwin"
        ? "raincode-desktop-mac"
        : desktop.platform === "win32"
          ? "raincode-desktop-win"
          : desktop.platform === "linux"
            ? "raincode-desktop-linux"
            : null;
    root.classList.add("raincode-desktop");
    if (platformClass) root.classList.add(platformClass);

    const applyFullscreen = (fullscreen: boolean) => {
      root.classList.toggle("raincode-desktop-fullscreen", fullscreen);
    };
    applyFullscreen(false);
    void desktop.windowState?.().then((state) => {
      applyFullscreen(Boolean(state?.fullscreen));
    }).catch(() => {});
    const unsub = desktop.onWindowStateChange?.((state) => {
      applyFullscreen(Boolean(state?.fullscreen));
    });

    return () => {
      unsub?.();
      root.classList.remove(
        "raincode-desktop",
        "raincode-desktop-mac",
        "raincode-desktop-win",
        "raincode-desktop-linux",
        "raincode-desktop-fullscreen",
      );
    };
  }, []);

  // Tell Electron the shell has painted so cold-start splash can be dismissed.
  // Double rAF waits until layout + paint, not just commit.
  useLayoutEffect(() => {
    const desktop = typeof window !== "undefined" ? window.raincodeDesktop : undefined;
    if (!desktop?.isDesktop || typeof desktop.notifyUiReady !== "function") return;
    let cancelled = false;
    let outer = 0;
    let inner = 0;
    outer = window.requestAnimationFrame(() => {
      inner = window.requestAnimationFrame(() => {
        if (!cancelled) desktop.notifyUiReady?.();
      });
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(outer);
      window.cancelAnimationFrame(inner);
    };
  }, []);
  const chatInputRef = useRef<ChatInputHandle | null>(null);

  // Branch navigator state — populated by ChatWindow via onBranchDataChange
  const [branchTree, setBranchTree] = useState<SessionTreeNode[]>([]);
  const [branchActiveLeafId, setBranchActiveLeafId] = useState<string | null>(null);
  const branchLeafChangeFnRef = useRef<((leafId: string | null) => void) | null>(null);

  const handleBranchDataChange = useCallback((tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => {
    setBranchTree(tree);
    setBranchActiveLeafId(activeLeafId);
    branchLeafChangeFnRef.current = onLeafChange;
  }, []);

  const handleBranchLeafChange = useCallback((leafId: string | null) => {
    branchLeafChangeFnRef.current?.(leafId);
  }, []);

  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);

  const handleSystemPromptChange = useCallback((prompt: string | null) => {
    setSystemPrompt(prompt);
  }, []);

  // Session metrics live in session-metrics-store (ContextPanel/ContextTabBadge subscribe).
  // Trailing-edge debounce timers for the post-turn refreshes (see handleAgentEnd).
  const agentEndTimersRef = useRef<{
    sessions: ReturnType<typeof setTimeout> | null;
    explorer: ReturnType<typeof setTimeout> | null;
  }>({ sessions: null, explorer: null });
  const activeSessionIdRef = useRef<string | null>(selectedSession?.id ?? null);
  activeSessionIdRef.current = selectedSession?.id ?? null;

  useEffect(() => {
    // Stable ref object; only its timer fields are reassigned.
    const timers = agentEndTimersRef.current;
    return () => {
      if (timers.sessions) clearTimeout(timers.sessions);
      if (timers.explorer) clearTimeout(timers.explorer);
    };
  }, []);

  const handleSidebarToggle = useCallback(() => {
    setSidebarOpen((open) => !open);
  }, []);

  // Right panel — workspace tabs + drag-resizable width (left sidebar stays fixed)
  // Explorer file clicks open FileViewerModal, not a workspace tab.
  const [viewerFile, setViewerFile] = useState<ViewerFileTarget | null>(null);
  const rightExplorerRef = useRef<FileExplorerHandle>(null);
  const [explorerUploadBusy, setExplorerUploadBusy] = useState(false);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const {
    displayWidth: sidebarWidth,
    resizing: sidebarResizing,
    containerRef: sidebarContainerRef,
    handleResizeStart: handleSidebarResizeStart,
    cssVarStyle: sidebarWidthStyle,
  } = usePersistedPanelWidth({
    storageKey: SIDEBAR_WIDTH_KEY,
    cssVar: "--sidebar-width",
    minWidth: SIDEBAR_MIN,
    maxWidth: SIDEBAR_MAX,
    maxViewportFraction: SIDEBAR_MAX_VIEWPORT_FRACTION,
    dragSign: 1,
    enabled: !isMobile && sidebarOpen,
  });
  const {
    displayWidth: rightPanelWidth,
    resizing: rightPanelResizing,
    containerRef: rightPanelContainerRef,
    handleResizeStart: handleRightPanelResizeStart,
    cssVarStyle: rightPanelWidthStyle,
  } = usePersistedPanelWidth({
    storageKey: RIGHT_PANEL_WIDTH_KEY,
    cssVar: "--right-panel-width",
    minWidth: RIGHT_PANEL_MIN,
    maxWidth: RIGHT_PANEL_MAX,
    maxViewportFraction: 0.72,
    dragSign: -1,
    enabled: !isMobile && rightPanelOpen,
    defaultWidth: RIGHT_PANEL_DEFAULT,
  });
  const workspaceTabs = WORKSPACE_TABS;
  const [activeWorkspaceTabId, setActiveWorkspaceTabId] = useState<string>("review");
  // Workspace panels stay mounted behind display:none once opened so they keep
  // scroll position, expanded diffs and inputs across tab switches. Only the
  // *first* mount is deferred, to the first time the panel is actually shown.
  const [mountedWorkspaceTabIds, setMountedWorkspaceTabIds] = useState<string[]>([]);
  useEffect(() => {
    if (!rightPanelOpen) return;
    setMountedWorkspaceTabIds((prev) => (
      prev.includes(activeWorkspaceTabId) ? prev : [...prev, activeWorkspaceTabId]
    ));
  }, [activeWorkspaceTabId, rightPanelOpen]);
  const terminalWatchCwd = activeCwd ?? selectedSession?.cwd ?? newSessionCwd ?? null;
  const {
    terminalTabs,
    visibleTerminalTabs,
    activeTerminalTabId,
    setActiveTerminalTabId,
    mountedTerminalIds,
    addTerminalSession,
    closeTerminalSession,
  } = useAppShellTerminal({
    t: t as (key: string, params?: Record<string, string | number>) => string,
    isMobile,
    setSidebarOpen,
    setRightPanelOpen,
    setActiveWorkspaceTabId,
    terminalWatchCwd,
  });

  const openSessionStatsPanel = useCallback(() => {
    if (isMobile) setSidebarOpen(false);
    setRightPanelOpen(true);
    setActiveWorkspaceTabId("context");
  }, [isMobile]);

  // Same @mention format as the chat input's @ autocomplete, so the agent's
  // read tool resolves it the same way (it strips the @ prefix).
  const handleAtMention = useCallback((relativePath: string, isDir: boolean) => {
    chatInputRef.current?.insertText(buildAtMentionText(relativePath, isDir));
  }, []);

  const handleAtMentions = useCallback((relativePaths: string[]) => {
    const mentions = buildFileAtMentionsText(relativePaths);
    if (mentions) chatInputRef.current?.insertText(mentions);
  }, []);

  const handleFileLineMention = useCallback((relativePath: string, startLine: number, endLine: number) => {
    chatInputRef.current?.insertText(buildFileLineMentionText(relativePath, startLine, endLine));
  }, []);

  const initialSessionId = initialNavigation.sessionId;
  // True once the initial ?session= URL param has been resolved (or confirmed absent)
  const [initialSessionRestored, setInitialSessionRestored] = useState<boolean>(() => !initialSessionId);
  // Suppresses workspace wipe in handleCwdChange during session select / URL restore
  const suppressCwdBumpRef = useRef(false);
  /** Last top-left workspace { cwd, projectKey } — single compare baseline for
   *  switches. projectKey is the normalized comparison-only identity; raw
   *  cwd/projectRoot strings stay display/file-system only. */
  const activeWorkspaceRef = useRef<{ cwd: string | null; projectKey: string | null }>({
    cwd: null,
    projectKey: null,
  });

  useEffect(() => {
    const requestedCwd = initialNavigation.requestedCwd;
    if (!requestedCwd) return;

    const controller = new AbortController();
    setInitialCwdStatus("validating");
    setInitialCwdError(null);

    void apiFetch("/api/cwd/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: requestedCwd }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as { cwd?: string; error?: string };
        if (!response.ok || !data.cwd) {
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }

        // The sidebar will notify us when it adopts this cwd. Avoid remounting
        // the just-created empty chat during that initial synchronization.
        suppressCwdBumpRef.current = true;
        setNewSessionCwd(data.cwd);
        setInitialCwdStatus("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setInitialCwdError(error instanceof Error ? error.message : String(error));
        setInitialCwdStatus("error");
      });

    return () => controller.abort();
  }, [initialNavigation]);

  const handleCwdChange = useCallback((cwd: string | null, projectRoot?: string | null, projectKey?: string | null) => {
    // Product rule: top-left workspace is the source of truth for every surface.
    // Frontend-only switch — do not kill agents/PTYs; just leave them in the background.
    setActiveCwd(cwd);
    if (!cwd) {
      activeWorkspaceRef.current = { cwd: null, projectKey: null };
      return;
    }

    // Server-side project-identity keys arrive via projectKey; raw path is the
    // pre-hydration fallback (client must not import node:path).
    const newProject = projectKey ?? projectRoot ?? cwd;
    const prev = activeWorkspaceRef.current;

    // Consume suppress always so it cannot stick across a skipped notify.
    const suppressed = suppressCwdBumpRef.current;
    if (suppressed) suppressCwdBumpRef.current = false;

    // Suppress only protects the session/URL that armed it (notify cwd === that session).
    // If suppress was left armed and the user picks another workspace, fall through and switch UI.
    if (suppressed && (!selectedSession || selectedSession.cwd === cwd)) {
      activeWorkspaceRef.current = { cwd, projectKey: newProject };
      return;
    }

    const cwdChanged = prev.cwd !== null && prev.cwd !== cwd;
    // Key hydration for the same cwd (worktree API resolved, or the server
    // supplied a normalized key after a raw fallback) is not a switch — same
    // rule as upstream #490.
    const projectRefinedOnly =
      prev.cwd === cwd
      && prev.projectKey !== null
      && prev.projectKey !== newProject;
    const projectChanged =
      prev.projectKey !== null
      && newProject !== prev.projectKey
      && !projectRefinedOnly
      && prev.cwd !== null;

    activeWorkspaceRef.current = { cwd, projectKey: newProject };

    // First adoption (prev.cwd null) or pure root refinement: record only.
    if (prev.cwd === null || (!cwdChanged && !projectChanged)) {
      return;
    }

    // Align chrome to the new top-left workspace (UI only).
    setViewerFile(null);

    // Deselect chat if it isn't at this exact cwd (RPC/agent keeps running).
    const sessionStays = selectedSession?.cwd === cwd;
    if (!sessionStays) {
      setSelectedSession(null);
      setNewSessionCwd(null); // blank chat uses activeCwd via effectiveNewSessionCwd
      setSessionKey((k) => k + 1);
      setBranchTree([]);
      setBranchActiveLeafId(null);
      setSystemPrompt(null);
      router.replace("/", { scroll: false });
    } else {
      setBranchTree([]);
      setBranchActiveLeafId(null);
      setSystemPrompt(null);
    }
  }, [router, selectedSession]);
  const handleSelectSession = useCallback((session: SessionInfo, isRestore = false) => {
    if (activeSessionIdRef.current !== session.id) closeChildTranscript();
    setNewSessionCwd(null);
    // Same session id: update metadata only. Never remount ChatWindow and never
    // router.replace — both flash "Loading session..." after Settings → Models.
    const sameSession = activeSessionIdRef.current === session.id;
    if (sameSession) {
      setSelectedSession((prev) => {
        if (!prev || prev.id !== session.id) return session;
        return {
          ...prev,
          ...session,
          path: session.path || prev.path,
          name: session.name ?? prev.name,
          projectRoot: session.projectRoot ?? prev.projectRoot,
          projectKey: session.projectKey ?? prev.projectKey,
        };
      });
    } else {
      setSelectedSession(session);
      // ChatWindow key is sessionKey-only (stable across new→real id promote).
      // Different session must bump the epoch so the chat surface remounts.
      setSessionKey((k) => k + 1);
      setSystemPrompt(null);
      setBranchTree([]);
      setBranchActiveLeafId(null);
      branchLeafChangeFnRef.current = null;
    }
    setInitialSessionRestored(true);
    // On mobile, collapse the overlay drawer so the chat is revealed after pick.
    if (isMobile && !isRestore) setSidebarOpen(false);
    // Suppress only when the sidebar will actually notify a cwd change. If session.cwd
    // already matches the top-left workspace, onCwdChange may be skipped and a sticky
    // suppress would eat the *next* real workspace switch (chat stuck on old session).
    if (session.cwd !== activeWorkspaceRef.current.cwd) {
      suppressCwdBumpRef.current = true;
    }
    // Skip router.replace when restoring from URL, OR when already on this session —
    // replace on the same query remounts AppShell via Suspense in production.
    if (!isRestore && !sameSession) {
      router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
    }
  }, [router, isMobile]);


  const openWorkspaceTab = useCallback((kind: "review" | "history" | "explorer" | "context" | "terminal") => {
    setRightPanelOpen(true);
    setActiveWorkspaceTabId(kind);
  }, []);

  const handleNewSession = useCallback((_sessionId: string, cwd: string) => {
    closeChildTranscript();
    setSelectedSession(null);
    setNewSessionCwd(cwd);
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    if (isMobile) setSidebarOpen(false);
    router.replace("/", { scroll: false });
  }, [router, isMobile]);

  const handleTrySkill = useCallback((skill: SkillInfo) => {
    const cwd = activeCwd ?? selectedSession?.cwd ?? newSessionCwd;
    if (!cwd) return;
    setDraft(`new:${cwd}`, {
      value: "",
      images: [],
      attachedSkill: { name: skill.name, description: skill.description },
    });
    setSettingsOpen(false);
    handleNewSession(`try-${skill.name}`, cwd);
  }, [activeCwd, selectedSession, newSessionCwd, handleNewSession]);

  // Global keyboard shortcuts (Esc, ⌘K search, sidebar, settings, workspace tabs…)
  useGlobalKeyboardShortcuts({
    onNewSession: (cwd: string) => handleNewSession(`kb-${Date.now()}`, cwd),
    activeCwd: activeCwd ?? selectedSession?.cwd ?? newSessionCwd,
    onToggleSidebar: handleSidebarToggle,
    onOpenSettings: () => {
      setSettingsWarm(true);
      setSettingsOpen(true);
    },
    onToggleRightPanel: () => setRightPanelOpen((v) => !v),
    onOpenShortcutsHelp: () => setShortcutsHelpOpen(true),
    onFocusComposer: () => chatInputRef.current?.focus(),
    onWorkspaceTab: openWorkspaceTab,
    suppressEscAbort: shortcutsHelpOpen || settingsOpen,
  });

  // Client-built transient SessionInfo (new session / fork) lacks the
  // server-computed projectRoot, which the same-project check in
  // handleCwdChange relies on. Hydrate it from the session list so switching
  // worktrees right after creating a session doesn't close the chat.
  const hydrateSelectedSession = useCallback((sessionId: string) => {
    // fresh=1: session was just created/forked on heavy; light list cache is stale.
    void apiFetch("/api/sessions?fresh=1")
      .then((r) => (r.ok ? (r.json() as Promise<{ sessions: SessionInfo[] }>) : null))
      .then((d) => {
        const full = d?.sessions.find((s) => s.id === sessionId);
        if (!full) return;
        setSelectedSession((prev) => (prev && prev.id === sessionId && !prev.projectRoot ? full : prev));
      })
      .catch(() => {});
  }, []);

  // Called by ChatWindow when a new session gets its real id from pi.
  // Must NOT bump sessionKey / remount ChatWindow — that wiped the optimistic
  // first message + stream and flashed "Loading session...".
  const handleSessionCreated = useCallback((session: SessionInfo) => {
    setNewSessionCwd(null);
    setSelectedSession(session);
    setRefreshKey((k) => k + 1);
    hydrateSelectedSession(session.id);
    // Prefer history.replaceState so Next Suspense does not remount AppShell mid-stream
    // (router.replace on searchParams has remounted the shell in production).
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("session", session.id);
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    } else {
      router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
    }
  }, [router, hydrateSelectedSession]);

  const scheduleExplorerRefresh = useCallback(() => {
    const timers = agentEndTimersRef.current;
    // Coalesce write/edit bursts and post-turn refresh through one timer.
    if (timers.explorer) clearTimeout(timers.explorer);
    timers.explorer = setTimeout(() => {
      timers.explorer = null;
      setExplorerRefreshKey((k) => k + 1);
    }, EXPLORER_REFRESH_DEBOUNCE_MS);
  }, []);

  useEffect(
    () => subscribeWorkspaceFilesChanged(scheduleExplorerRefresh),
    [scheduleExplorerRefresh],
  );

  // Floating overlay thumbs for [data-overlay-scroll] containers (native bars
  // are zero-width app-wide). Module is idempotent; one observer for the app.
  useEffect(() => {
    initOverlayScrollbars();
  }, []);

  const handleAgentEnd = useCallback(() => {
    const timers = agentEndTimersRef.current;
    // The session list only carries messageCount / mtime here — running badges
    // only refresh running badges via visible-tab poll — so it can lag a turn.
    if (timers.sessions) clearTimeout(timers.sessions);
    timers.sessions = setTimeout(() => {
      timers.sessions = null;
      setRefreshKey((k) => k + 1);
      invalidateUsage();
    }, SESSION_REFRESH_DEBOUNCE_MS);
    scheduleExplorerRefresh();
  }, [scheduleExplorerRefresh]);

  const handleSessionRenamed = useCallback((sessionId: string, name: string) => {
    setSelectedSession((current) => (current?.id === sessionId ? { ...current, name } : current));
    const currentStats = getSessionStatsMetric();
    if (currentStats?.sessionId === sessionId) {
      setSessionStatsMetric({ ...currentStats, sessionName: name });
    }
  }, []);

  const handleExplorerRefresh = useCallback(() => {
    setExplorerRefreshKey((k) => k + 1);
  }, []);


  const handleSessionForked = useCallback((newSessionId: string) => {
    setRefreshKey((k) => k + 1);
    setSessionKey((k) => k + 1);
    setNewSessionCwd(null);
    setSelectedSession((prev) => ({
      ...(prev ?? { path: "", cwd: "", created: "", modified: "", messageCount: 0, firstMessage: "" }),
      id: newSessionId,
    }));
    hydrateSelectedSession(newSessionId);
    router.replace(`?session=${encodeURIComponent(newSessionId)}`, { scroll: false });
  }, [router, hydrateSelectedSession]);

  const handleInitialRestoreDone = useCallback(() => {
    setInitialSessionRestored(true);
  }, []);

  const handleSessionDeleted = useCallback((sessionId: string) => {
    // Selection only — SessionSidebar owns list reload after DELETE settles.
    // Bumping refreshKey here raced mid-delete disk scans and reinserted the row.
    if (selectedSession?.id === sessionId) {
      const cwd = selectedSession.cwd;
      setSelectedSession(null);
      setNewSessionCwd(cwd ?? null);
      setSessionKey((k) => k + 1);
      setBranchTree([]);
      setBranchActiveLeafId(null);
      setSystemPrompt(null);
      router.replace("/", { scroll: false });
    }
  }, [selectedSession, router]);

  const handleOpenFile = useCallback((
    filePath: string,
    _fileName: string,
    sourceSessionId?: string | null,
    focusLine?: number | null,
  ) => {
    // Files open in a floating modal — no workspace file tabs anymore.
    setViewerFile((prev) => ({
      filePath,
      sourceSessionId: sourceSessionId || (prev?.filePath === filePath ? prev.sourceSessionId : null),
      focusLine: focusLine ?? null,
    }));
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);


  const handleOpenLinkedFile = useCallback((filePath: string) => {
    handleOpenFile(filePath, getFileName(filePath), selectedSession?.id ?? null);
  }, [handleOpenFile, selectedSession?.id]);

  // Show chat area if a session is selected, or if we have a cwd to start a new session in
  const effectiveNewSessionCwd = newSessionCwd ?? (selectedSession === null && activeCwd ? activeCwd : null);
  const showChat = selectedSession !== null || effectiveNewSessionCwd !== null;
  // While restoring initial session from URL, don't show the placeholder
  const showPlaceholder = initialSessionRestored && !showChat;
  const projectTrustCwd = selectedSession?.cwd ?? effectiveNewSessionCwd;

  const [projectTrust, setProjectTrust] = useState<ProjectTrustStatus | null>(null);
  const [projectTrustDialogOpen, setProjectTrustDialogOpen] = useState(false);
  const [projectTrustBusy, setProjectTrustBusy] = useState(false);
  const [projectTrustError, setProjectTrustError] = useState<string | null>(null);

  useEffect(() => {
      setProjectTrust(null);
      setProjectTrustDialogOpen(false);
      setProjectTrustError(null);
      if (!projectTrustCwd) return;

      const controller = new AbortController();
      // Trust is enforced server-side at session start; the dialog may arrive late.
      // Prefer idle so the first paint of chat content is not racing this request.
      const load = () => {
        apiFetch(`/api/project-trust?cwd=${encodeURIComponent(projectTrustCwd)}`, {
          signal: controller.signal,
        })
          .then(async (response) => {
            const data = await response.json() as ProjectTrustStatus & { error?: string };
            if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
            setProjectTrust(data);
          })
          .catch((error) => {
            if (error instanceof DOMException && error.name === "AbortError") return;
            console.error("Failed to load project trust:", error);
          });
      };

      if (typeof requestIdleCallback === "function") {
        const idleId = requestIdleCallback(load, { timeout: 1500 });
        return () => {
          cancelIdleCallback(idleId);
          controller.abort();
        };
      }
      const timer = window.setTimeout(load, 100);
      return () => {
        window.clearTimeout(timer);
        controller.abort();
      };
    }, [projectTrustCwd]);

    const handleTrustProject = useCallback(async () => {
    if (!projectTrustCwd || projectTrustBusy) return;
    setProjectTrustBusy(true);
    setProjectTrustError(null);
    try {
      const response = await apiFetch("/api/project-trust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: projectTrustCwd }),
      });
      const data = await response.json() as ProjectTrustStatus & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setProjectTrust(data);
      setProjectTrustDialogOpen(false);
      setModelsRefreshKey((key) => key + 1);
      setSessionKey((key) => key + 1);
    } catch (error) {
      setProjectTrustError(error instanceof Error ? error.message : String(error));
    } finally {
      setProjectTrustBusy(false);
    }
  }, [projectTrustBusy, projectTrustCwd]);

  const activeCwdName = activeCwd ? getFileName(activeCwd) || activeCwd : null;
  const windowTitle = activeCwdName ? `${activeCwdName} - RainCode` : "RainCode";

  useEffect(() => {
    const syncWindowTitle = () => {
      if (document.title !== windowTitle) document.title = windowTitle;
    };

    syncWindowTitle();
    const observer = new MutationObserver(syncWindowTitle);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [windowTitle]);

  const sidebarContent = (
    <div
      className="sidebar-shell"
      style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, overflow: "hidden" }}
    >
      <SessionSidebar
        selectedSessionId={selectedSession?.id ?? null}
        onSelectSession={handleSelectSession}
        onNewSession={handleNewSession}
        initialSessionId={initialSessionId}
        skipInitialProjectSelection={initialNavigation.requestedCwd !== null}
        onInitialRestoreDone={handleInitialRestoreDone}
        refreshKey={refreshKey}
        onSessionDeleted={handleSessionDeleted}
        onSessionRenamed={handleSessionRenamed}
        // Prefer top-left workspace (activeCwd); fall back to session / new-chat cwd.
        selectedCwd={activeCwd ?? selectedSession?.cwd ?? newSessionCwd ?? null}
        onCwdChange={handleCwdChange}
        onExplorerRefresh={handleExplorerRefresh}
      />
    </div>
  );

  return (
    <>
    <ShellStyles />
    <div style={{ display: "flex", height: "100dvh", overflow: "hidden", background: "var(--canvas)" }}>
      {/* Mobile overlay backdrop */}
      <div
        className={`sidebar-overlay-backdrop${mobileSidebarReady ? "" : " sidebar-mobile-pending"}`}
        onClick={() => setSidebarOpen(false)}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 199,
          background: "var(--overlay-bg)",
          opacity: sidebarOpen ? 1 : 0,
          pointerEvents: sidebarOpen ? "auto" : "none",
          transition: "opacity 0.25s ease",
        }}
      />

      {/* Left sidebar — hidden while the in-shell settings page is showing
          (settings brings its own level-2 nav, LocalApi idiom) */}
      <div
        ref={sidebarContainerRef}
        className={`sidebar-container${sidebarOpen ? " sidebar-open" : " sidebar-closed"}${mobileSidebarReady ? "" : " sidebar-mobile-pending"}${sidebarResizing ? " is-resizing" : ""}`}
        style={{
          display: settingsOpen ? "none" : "flex",
          flexDirection: "column",
          flexShrink: 0,
          zIndex: 200,
          ...sidebarWidthStyle,
        }}
      >
        {sidebarContent}
      </div>
      {sidebarOpen && !isMobile && !settingsOpen && (
        <div
          className="sidebar-seam titlebar-no-drag"
          style={{
            position: "relative",
            flex: "0 0 8px",
            width: 8,
            minWidth: 8,
            marginRight: -8,
            alignSelf: "stretch",
            zIndex: 60,
            overflow: "visible",
          }}
        >
          <div
            className={`sidebar-edge-resizer${sidebarResizing ? " is-active" : ""}`}
            role="separator"
            aria-orientation="vertical"
            aria-valuenow={sidebarWidth}
            aria-valuemin={SIDEBAR_MIN}
            aria-valuemax={SIDEBAR_MAX}
            aria-label={t("shell.resizeSidebar")}
            title={t("shell.resizeSidebar")}
            onPointerDown={handleSidebarResizeStart}
            style={{
              background: sidebarResizing
                ? "color-mix(in oklab, var(--accent) 30%, transparent)"
                : "transparent",
            }}
          />
        </div>
      )}


      {/* Center: chat — top bar sits openly on the canvas; content floats as a panel */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        <ShellTopBar
          sidebarOpen={sidebarOpen}
          reserveTrafficLights={settingsOpen}
          onToggleSidebar={handleSidebarToggle}
          settingsOpen={settingsOpen}
          onOpenChat={() => setSettingsOpen(false)}
          onOpenSettings={() => {
            setSettingsWarm(true);
            setSettingsOpen(true);
          }}
          onWarmSettings={() => setSettingsWarm(true)}
          session={selectedSession}
          showChat={showChat}
          appUpdate={appUpdate}
          rightPanelOpen={rightPanelOpen}
          onToggleRightPanel={() => setRightPanelOpen((v) => !v)}
        />

        {/* Settings page — in-flow, replaces the chat panel (chat stays mounted
            underneath so its state survives). Warm-mounted after first use. */}
        {settingsWarm && (
          <SettingsPage
            visible={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            cwd={activeCwd ?? selectedSession?.cwd ?? newSessionCwd}
            skillsDisabled={!activeCwd && !selectedSession?.cwd && !newSessionCwd}
            onModelsChanged={handleModelsChanged}
            onTrySkill={handleTrySkill}
            onSessionsChanged={() => setRefreshKey((k) => k + 1)}
          />
        )}

        {/* Chat content — floating panel on the canvas */}
        <div style={{ flex: 1, minHeight: 0, padding: "0 8px 8px", display: settingsOpen ? "none" : "flex", flexDirection: "column" }}>
        <div className="shell-panel" style={{ flex: 1, minHeight: 0, position: "relative", display: "flex", flexDirection: "column" }}>
          {showChat && projectTrust?.requiresTrust && !projectTrust.trusted && (
            <button
              type="button"
              className="chrome-btn"
              onClick={() => {
                setProjectTrustError(null);
                setProjectTrustDialogOpen(true);
              }}
              title={t("trust.resourcesNotLoaded")}
              aria-label={t("trust.resourcesNotLoaded")}
              style={{
                width: "100%",
                height: 32,
                minHeight: 32,
                borderRadius: 0,
                borderBottom: "1px solid var(--border)",
                justifyContent: "flex-start",
                padding: "0 12px",
                gap: 8,
                color: "var(--text-muted)",
                background: "var(--bg-panel)",
                flexShrink: 0,
              }}
            >
              <Icon icon={ShieldAlert} size={13} strokeWidth={1.8} />
              <span style={{ fontSize: 12 }}>{t("trust.resourcesNotLoaded")}</span>
              <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-dim)" }}>{t("trust.trustProject")}</span>
            </button>
          )}
          {showChat ? (
            <>
              <div style={{ flex: 1, minHeight: 0, display: childOpen ? "none" : "flex", flexDirection: "column" }}>
            <ChatWindow
              // Epoch only — do not key by session id. First send promotes new→real id;
              // keying by id remounted the surface into "Loading session..." mid-stream.
              key={`chat:${sessionKey}`}
              session={selectedSession}
              newSessionCwd={effectiveNewSessionCwd}
              onAgentEnd={handleAgentEnd}
              onSessionCreated={handleSessionCreated}
              onSessionForked={handleSessionForked}
              modelsRefreshKey={modelsRefreshKey}
              chatInputRef={chatInputRef}
              onBranchDataChange={handleBranchDataChange}
              onSystemPromptChange={handleSystemPromptChange}
              onSessionStatsPanelOpen={openSessionStatsPanel}
              onOpenFile={handleOpenLinkedFile}
            />
              </div>
              {childOpen ? (
                <ChildChatPane cwd={selectedSession?.cwd} onOpenFile={handleOpenLinkedFile} />
              ) : null}
            </>
          ) : initialCwdStatus === "validating" ? (
            <div
              role="status"
              style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}
            >
              <div style={{ fontSize: 14, color: "var(--text)" }}>{t("shell.openingWorkspace")}</div>
              <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                {initialNavigation.requestedCwd}
              </div>
            </div>
          ) : initialCwdStatus === "error" ? (
            <div
              role="alert"
              style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}
            >
              <div style={{ fontSize: 14, color: "var(--destructive)" }}>{t("shell.unableOpenWorkspace")}</div>
              <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                {initialNavigation.requestedCwd}
              </div>
              <div style={{ maxWidth: 720, fontSize: 12 }}>{initialCwdError}</div>
            </div>
          ) : showPlaceholder ? (
            activeCwd ? (
              <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 15 }}>
                {t("shell.selectSession")}
              </div>
            ) : (
              <div style={{ position: "absolute", top: 12, left: 12, display: "flex", alignItems: "flex-start", gap: 8, userSelect: "none", pointerEvents: "none" }}>
                <Icon
                  icon={ArrowLeft}
                  size={44}
                  strokeWidth={1.5}
                  style={{ color: "var(--accent)", opacity: 0.7, flexShrink: 0 }}
                />
                <div>
                  <div style={{ fontSize: 18, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>{t("shell.getStarted")}</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.8 }}>
                    <span style={{ color: "var(--text-dim)", marginRight: 6 }}>1.</span>{t("shell.step1")}<br />
                    <span style={{ color: "var(--text-dim)", marginRight: 6 }}>2.</span>{t("shell.step2a")} <strong style={{ color: "var(--text)" }}>{t("shell.settings")}</strong> {t("shell.step2b")}
                  </div>
                </div>
              </div>
            )
          ) : null}
        </div>
        </div>
      </div>

      {/*
        Seam handle: zero layout width, sits exactly between chat rail and right panel.
        Absolute hit target straddles the 1px border (half into rail, half into panel).
      */}
      {rightPanelOpen && !isMobile && !settingsOpen && (
        <div
          className="right-panel-seam titlebar-no-drag"
          style={{
            position: "relative",
            flex: "0 0 0px",
            width: 0,
            minWidth: 0,
            alignSelf: "stretch",
            zIndex: 60,
            overflow: "visible",
          }}
        >
          <div
            className={`right-panel-edge-resizer${rightPanelResizing ? " is-active" : ""}`}
            role="separator"
            aria-orientation="vertical"
            aria-valuenow={rightPanelWidth}
            aria-valuemin={RIGHT_PANEL_MIN}
            aria-valuemax={RIGHT_PANEL_MAX}
            aria-label={t("shell.resizeFilePanel")}
            title={t("shell.resizeFilePanel")}
            onPointerDown={handleRightPanelResizeStart}
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              // Center on the seam: 4px into rail, 4px into panel
              left: -4,
              width: 8,
              minWidth: 8,
              maxWidth: 8,
              cursor: "col-resize",
              touchAction: "none",
              background: rightPanelResizing
                ? "color-mix(in oklab, var(--accent) 30%, transparent)"
                : "transparent",
            }}
          />
        </div>
      )}

      {/* Right panel — second floating panel on the canvas */}
      <div
        ref={rightPanelContainerRef}
        className={`right-panel-container${rightPanelOpen ? " right-panel-open" : " right-panel-closed"}${rightPanelResizing ? " is-resizing" : ""}`}
        style={{
          display: settingsOpen ? "none" : "flex",
          flexDirection: "column",
          background: "transparent",
          position: "relative",
          overflow: "hidden",
          ...rightPanelWidthStyle,
        }}
      >
        {/* Workspace tabs sit openly on the canvas — the floating panel starts
            below the strip (Review | Explorer | Context | Terminal). */}
        <div className="app-topbar titlebar-drag desktop-top-chrome" style={{ display: rightPanelOpen ? "flex" : "none", flexDirection: "row", alignItems: "center", flexShrink: 0, background: "transparent", height: "var(--titlebar-height)" }}>
          <div className="titlebar-no-drag right-workspace-tabs">
            {workspaceTabs.map((tab) => {
              const active = tab.id === activeWorkspaceTabId;
              const label =
                tab.kind === "review" ? t("git.review")
                  : tab.kind === "history" ? t("git.history")
                    : tab.kind === "explorer" ? t("sidebar.explorer")
                      : tab.kind === "context" ? t("shell.contextTab")
                        : tab.kind === "browser" ? t("shell.browserTab")
                          : t("git.terminal");
              return (
                <button
                  key={tab.id}
                  type="button"
                  className={`right-workspace-tab${active ? " is-active" : ""}`}
                  onClick={() => setActiveWorkspaceTabId(tab.id)}
                  title={label}
                  aria-label={label}
                  aria-pressed={active}
                >
                  {tab.kind === "review" ? (
                    <Icon icon={FileText} size={12} strokeWidth={1.8} />
                  ) : tab.kind === "history" ? (
                    <Icon icon={History} size={12} strokeWidth={1.8} />
                  ) : tab.kind === "explorer" ? (
                    <Icon icon={Folder} size={12} strokeWidth={1.8} />
                  ) : tab.kind === "context" ? (
                    <Icon icon={CircleGauge} size={12} strokeWidth={1.8} />
                  ) : tab.kind === "browser" ? (
                    <Icon icon={Globe} size={12} strokeWidth={1.8} />
                  ) : (
                    <Icon icon={Terminal} size={12} strokeWidth={1.8} />
                  )}
                  <span className="right-workspace-tab-label">{label}</span>
                  {tab.kind === "context" && <ContextTabBadge />}
                  {tab.kind === "terminal" && visibleTerminalTabs.length > 0 && (
                    <span className="right-workspace-tab-count">{visibleTerminalTabs.length}</span>
                  )}
                </button>
              );
            })}
            <div className="titlebar-drag" style={{ flex: 1, height: "100%" }} aria-hidden />
          </div>
          {/* Mobile: the panel is full-width and the top bar's own toggle is
              squeezed out — this is the only way back to chat (P0). */}
          {isMobile && (
            <button
              type="button"
              className="chrome-btn is-icon right-workspace-close titlebar-no-drag"
              onClick={() => setRightPanelOpen(false)}
              title={t("shell.hideFilePanel")}
              aria-label={t("shell.hideFilePanel")}
            >
              <Icon icon={X} size={15} strokeWidth={1.8} />
            </button>
          )}
          {/* Right panel is the rightmost chrome when open — host caption buttons here. */}
          <WindowControls />
        </div>
        <div
          className="shell-panel"
          style={{
            flex: 1,
            minHeight: 0,
            width: "auto",
            // Mobile: the panel is full-width with no chat column on its left,
            // so it needs the same 8px canvas gutter on both sides.
            margin: isMobile ? "0 8px 8px" : "0 8px 8px 0",
            display: rightPanelOpen ? "flex" : "none",
            flexDirection: "column",
          }}
        >
        <div style={{ flex: 1, overflow: "hidden", minHeight: 0, display: "flex", flexDirection: "column", position: "relative" }}>
          {/* Panels mount on first open and stay mounted (hidden) afterwards,
              so switching tabs never resets their internal state. */}
          <div style={{
            display: activeWorkspaceTabId === "review" ? "flex" : "none",
            flexDirection: "column",
            flex: 1,
            minHeight: 0,
            overflow: "hidden",
          }}>
            {mountedWorkspaceTabIds.includes("review") && (
              <GitPanel
                cwd={activeCwd}
                refreshKey={explorerRefreshKey}
                onMutated={scheduleExplorerRefresh}
                onReviewSessionStarted={(session) => {
                  setNewSessionCwd(null);
                  setSelectedSession({
                    id: session.id,
                    path: "",
                    cwd: session.cwd,
                    created: new Date().toISOString(),
                    modified: new Date().toISOString(),
                    messageCount: 1,
                    firstMessage: session.name ?? "Git review",
                    name: session.name,
                  });
                  setSessionKey((k) => k + 1);
                  setRefreshKey((k) => k + 1);
                  hydrateSelectedSession(session.id);
                  router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
                  if (isMobile) setSidebarOpen(false);
                }}
              />
            )}
          </div>

          <div style={{
            display: activeWorkspaceTabId === "history" ? "flex" : "none",
            flexDirection: "column",
            flex: 1,
            minHeight: 0,
            overflow: "hidden",
          }}>
            {mountedWorkspaceTabIds.includes("history") && activeCwd && (
              <GitHistory cwd={activeCwd} historyKey={explorerRefreshKey} />
            )}
            {mountedWorkspaceTabIds.includes("history") && !activeCwd && (
              <div style={{ padding: "16px 14px", color: "var(--text-dim)", fontSize: 12 }}>
                {t("sidebar.selectProjectFirst")}
              </div>
            )}
          </div>

          <div style={{
            display: activeWorkspaceTabId === "explorer" ? "flex" : "none",
            flexDirection: "column",
            flex: 1,
            minHeight: 0,
            overflow: "hidden",
          }}>
            {mountedWorkspaceTabIds.includes("explorer") && (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 4, height: 32, padding: "0 8px", flexShrink: 0 }}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {t("sidebar.explorer")}
                  </span>
                  <button
                    type="button"
                    className="chrome-btn is-icon"
                    style={{ width: isMobile ? 32 : 24, minWidth: isMobile ? 32 : 24, height: isMobile ? 32 : 24, borderRadius: "var(--radius-sm)" }}
                    onClick={() => rightExplorerRef.current?.openUploadPicker()}
                    disabled={explorerUploadBusy}
                    title={t("sidebar.uploadToRoot")}
                    aria-label={t("sidebar.uploadFiles")}
                  >
                    <Icon icon={Upload} size={13} strokeWidth={1.8} />
                  </button>
                </div>
                <div data-overlay-scroll data-overlay-scroll-inset-bottom={12} style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" }}>
                  {terminalWatchCwd ? (
                    <FileExplorer
                      ref={rightExplorerRef}
                      cwd={terminalWatchCwd}
                      onOpenFile={(filePath, fileName) => handleOpenFile(filePath, fileName, selectedSession?.id ?? null)}
                      refreshKey={explorerRefreshKey}
                      onAtMention={handleAtMention}
                      onAtMentions={handleAtMentions}
                      onUploadBusyChange={setExplorerUploadBusy}
                    />
                  ) : (
                    <div style={{ padding: "16px 14px", color: "var(--text-dim)", fontSize: 12 }}>
                      {t("sidebar.selectProjectFirst")}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          <div style={{
            display: activeWorkspaceTabId === "context" ? "flex" : "none",
            flexDirection: "column",
            flex: 1,
            minHeight: 0,
            overflow: "hidden",
          }}>
            {mountedWorkspaceTabIds.includes("context") && <ContextPanel />}
          </div>

          <div style={{
            display: activeWorkspaceTabId === "terminal" ? "flex" : "none",
            flexDirection: "column",
            flex: 1,
            minHeight: 0,
            overflow: "hidden",
          }}>
            {/* Terminal subtabs — only this workspace; other workspaces stay mounted off-screen. */}
            <div className="file-subtabs titlebar-no-drag">
              {visibleTerminalTabs.map((tab) => {
                const isActive = tab.id === activeTerminalTabId;
                return (
                  <div
                    key={tab.id}
                    role="tab"
                    tabIndex={0}
                    className={`file-subtab${isActive ? " is-active" : ""}`}
                    title={tab.label}
                    aria-label={tab.label}
                    aria-selected={isActive}
                    onClick={() => setActiveTerminalTabId(tab.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setActiveTerminalTabId(tab.id);
                      }
                    }}
                    onMouseDown={(e) => {
                      if (e.button === 1) e.preventDefault();
                    }}
                    onAuxClick={(e) => {
                      if (e.button !== 1) return;
                      e.preventDefault();
                      e.stopPropagation();
                      closeTerminalSession(tab.id);
                    }}
                  >
                    <span className="file-subtab-icon" aria-hidden>
                      <Icon icon={Terminal} size={12} strokeWidth={1.8} />
                    </span>
                    <span className="file-subtab-label">{tab.label}</span>
                    <button
                      type="button"
                      className="file-subtab-close"
                      title={t("tab.close")}
                      aria-label={t("tab.closeNamed", { name: tab.label })}
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTerminalSession(tab.id);
                      }}
                    >
                      <Icon icon={X} size={10} strokeWidth={1.8} />
                    </button>
                  </div>
                );
              })}
              <button
                type="button"
                className="chrome-btn is-icon file-subtab-add"
                onClick={addTerminalSession}
                title={t("git.newTerminal")}
                aria-label={t("git.newTerminal")}
              >
                <Icon icon={Plus} size={12} strokeWidth={2} />
              </button>
            </div>

            <div style={{ flex: 1, minHeight: 0, overflow: "hidden", position: "relative" }}>
              {/* Always keep mounted panels for every workspace so PTYs keep running off-screen. */}
              {terminalTabs.map((tab) => {
                if (!mountedTerminalIds.includes(tab.id)) return null;
                const inWorkspace = !tab.cwd || tab.cwd === terminalWatchCwd;
                const active = inWorkspace && tab.id === activeTerminalTabId;
                return (
                  <div
                    key={tab.id}
                    style={{
                      display: active ? "flex" : "none",
                      flexDirection: "column",
                      position: "absolute",
                      inset: 0,
                      minHeight: 0,
                      overflow: "hidden",
                    }}
                  >
                    <TerminalPanel
                      cwd={tab.cwd ?? terminalWatchCwd}
                      attachSessionId={tab.attachSessionId ?? null}
                      sourceLabel={tab.source === "agent" ? tab.label : null}
                      persistRemoteOnUnmount
                    />
                  </div>
                );
              })}
              {visibleTerminalTabs.length === 0 && (
                <div style={{
                  height: "100%",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 10,
                  color: "var(--text-dim)",
                  fontSize: 12,
                  position: "relative",
                  zIndex: 1,
                }}>
                  <span>{t("git.terminal")}</span>
                  <button type="button" className="chrome-btn" onClick={addTerminalSession}>
                    {t("git.newTerminal")}
                  </button>
                </div>
              )}
            </div>
          </div>

          <div style={{
            display: activeWorkspaceTabId === "browser" ? "flex" : "none",
            flexDirection: "column",
            flex: 1,
            minHeight: 0,
            overflow: "hidden",
          }}>
            {mountedWorkspaceTabIds.includes("browser") && (
              <BrowserPanel
                sessionId={selectedSession?.id ?? null}
                visible={rightPanelOpen && activeWorkspaceTabId === "browser"}
                suspended={rightPanelResizing || viewerFile !== null || settingsOpen}
              />
            )}
          </div>
        </div>
        </div>
      </div>
    </div>
    {projectTrustDialogOpen && projectTrustCwd && (
      <ProjectTrustDialog
        cwd={projectTrustCwd}
        busy={projectTrustBusy}
        error={projectTrustError}
        onCancel={() => {
          if (!projectTrustBusy) setProjectTrustDialogOpen(false);
        }}
        onConfirm={() => void handleTrustProject()}
      />
    )}
    <SessionInspectDialogs
      selectedSessionId={selectedSession?.id ?? null}
      tree={branchTree}
      activeLeafId={branchActiveLeafId}
      onLeafChange={handleBranchLeafChange}
      systemPrompt={systemPrompt}
      onSystemPrompt={setSystemPrompt}
    />
    <ShortcutsHelpDialog
      open={shortcutsHelpOpen}
      onClose={() => setShortcutsHelpOpen(false)}
    />
    {viewerFile && (
      <FileViewerModal
        file={viewerFile}
        cwd={activeCwd ?? undefined}
        gitRefreshKey={explorerRefreshKey}
        onClose={() => setViewerFile(null)}
        onOpenFile={(filePath) => handleOpenFile(filePath, getFileName(filePath), viewerFile.sourceSessionId)}
        onMentionLines={handleFileLineMention}
        onMentionFile={(rel) => handleAtMention(rel, false)}
      />
    )}
    </>
  );
}
