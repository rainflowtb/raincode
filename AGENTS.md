# RainCode - Development Notes

## Quick Start

```bash
npm run desktop:build && npm run electron   # the product: Electron desktop client
```

Typecheck: `node_modules/.bin/tsc --noEmit` · Lint: `npm run lint` · Runtime protocol regression: `npm run smoke:ipc`

No always-on web server: the Electron main process serves the renderer over `app://` and talks to two agent runtime child processes over IPC. Read `docs/desktop-architecture.md` before changing transport, packaging, or which process a route runs in. Exception: opt-in **LAN access** (Settings → General) — `electron/lan-server.js` serves `desktop-dist` + `/api/*` on port 39141 behind an optional access key.

`next build` survives only as a dependency-tracing step for packaging. **Never run it during dev** — it pollutes `.next/`.

---

## AI Coding Constraints

Hard rules for every agent change. They govern **how you change code**; `Key Design Decisions & Traps` explains **why the code is the way it is** — do not "fix" traps by stacking another recovery path. Cleanup roadmap: `docs/superpowers/specs/2026-08-02-declutter-design.md`.

### Non-negotiables

1. **MUST NOT** add a new fallback / retry / reconcile / grace / poll path for a failure mode that already has one. Merge or replace the existing path first.
2. **MUST NOT** fix a bug only by widening `try/catch`, optional chaining, or "ignore error" without naming the invariant that failed.
3. **MUST NOT** duplicate the same semantic across UI + hook + API + rpc. One owner module; others call it.
4. **MUST** prefer deleting or merging code over adding guards when both would silence the symptom.
5. **MUST NOT** introduce `as any`, `@ts-ignore`, or lint disables to silence a type error caused by the change.
6. **Transport has one owner.** Renderer code **MUST** call `apiFetch` / `apiStream` from `lib/api-transport.ts` — a raw `fetch("/api/…")` or `new EventSource(…)` has no origin under `app://`. Same for **element URLs** (`<img>`/`<audio>`/`<iframe>`/`<a download>`): `/api/…` src/href must go through `hooks/useApiObjectUrl.ts` (blob bridge) or `components/api-file-media.tsx`.
7. **MUST NOT** add a static import reaching `@earendil-works/*` to a route listed as light in `electron/runtime-host.js` — that pulls the agent SDK into the process whose purpose is to never load it (classification rule in `docs/desktop-architecture.md`).

### Hot-path rules

Applies to `hooks/useAgentSession.ts`, `lib/rpc-manager.ts`, `components/ChatWindow.tsx`, `app/api/agent/**`.

8. **Single flight for run lifecycle**: one monotonic run id owns streaming UI; late SSE and reconcile **MUST** no-op when `runId !== current`. No fourth anti-stale mechanism.
9. **SSE is primary; reconcile is backup only.** **MUST NOT** add a new periodic poller or `visibilitychange` / `online` listener for agent chat state. Extend the existing reconcile hook or remove it after proving SSE + settlement suffice.
10. **Fork / session identity**: after any op that mutates wrapper identity (`fork`, destroy, reload), **MUST** drop the registry entry for the old id in the same turn. **MUST NOT** paper over wrong-id bugs with extra path lookups.
11. **Settlement / grace**: **MUST NOT** stack another timer/grace on the existing post-prompt grace. If late events drop, fix emission or the single grace owner.
12. **Scroll**: owned by `use-stick-to-bottom`. **MUST NOT** reintroduce ad-hoc `scrollTop` writers except the documented settle / pagination / minimap exceptions under Traps.

### Size & structure

13. **Soft cap**: a touched file already **> 800 lines** **MUST NOT** grow by more than ~30 net lines unless the same change extracts at least that many lines out.
14. **Hard trigger**: non-trivial logic in a file **> 1500 lines** → **MUST** extract a module/hook/component first. Current offenders: `ModelsConfig.tsx`, `MessageView.tsx`, `ChatInput.tsx`, `useAgentSession.ts`, `SettingsPage.tsx`, `ChatWindow.tsx`, `SessionSidebar.tsx`, `AppShell.tsx`, `rpc-manager.ts`.
15. **One concern per new file**, with a one-sentence responsibility in a file-header comment. No new `utils.ts` / `helpers.ts` dump files.
16. **globalThis registries**: **MUST NOT** add `globalThis.__pi*` without (a) why module scope is not enough, (b) a clear owner file, (c) invalidate/cleanup API. Prefer extending an existing registry module.

### Dual-path / legacy

17. **MUST NOT** add a dual implementation (classic+new, bundle+TS, poll+SSE, …) "for compatibility" without an explicit removal condition in the commit message.
18. **Edit tool**: literal exact-match only — `{ path, edits: [{ oldText, newText, replaceAll? }] }` (`lib/literal-edit.ts`). `oldText` must be unique unless `replaceAll`; ambiguity is an error, never a guess. Read-before-edit enforced via `lib/file-observations.ts`. The hashline patch language was removed (corrupt edits in the wild); **MUST NOT** reintroduce a second edit syntax.
19. **Extensions**: prebundled factories preferred. **MUST NOT** add new runtime dependence on jiti / TS `additionalExtensionPaths` except the existing missing-bundle fallback in `builtin-extensions.ts`.
20. **Migrations**: idempotent and one-way. **MUST NOT** keep permanent read paths for pre-migration shapes after a shipped release (track removal in the declutter blueprint).

### Before you patch (mandatory self-check)

Answer in 1–2 lines each in the reply:

1. **Invariant** — what invariant is protected or fixed?
2. **Single owner** — where is the single entry for this state/logic?
3. **Path count** — which recovery path number is this? Can it be 1?
4. **Size** — any file >800 lines touched? Net line delta? Extract first?
5. **Legacy** — new dual-path? If yes, removal condition?

If (1)–(3) cannot be answered, **MUST NOT** land a patch-style fix.

### Out of scope for these rules

- Input validation, path security, auth, and project trust stay required.
- Existing hot-reload `globalThis` usage is allowed; **undocumented new bags** are not.
- Product feature count is not a violation; **same-layer duplicate mechanisms** and **ownerless fallbacks** are.
- Giant-file splits are a blueprint phase, not a same-PR obligation unless rules 13–14 trigger.

---

## Architecture

```
Renderer (app://)      Electron main            Agent runtimes (child procs, IPC)
  │                        │                               │
  ├─ apiFetch("/api/…") ──▶ runtime-host routes by path    │
  │                        ├──────────▶ light  ─ reads ~/.raincode/sessions/,
  │                        │                     files, git — never loads the SDK
  │                        └──────────▶ heavy  ─ SDK + AgentSession registry
  │                        │                               │
  ├─ send message ─────────▶ POST /api/agent/[id] ────────▶│ startRpcSession()
  │                        │                               │ session.prompt()
  ├─ apiStream(…/events) ──▶ chunks relayed over IPC ◀─────│ session.subscribe()
```

All renderer → runtime traffic goes through `lib/api-transport.ts`; route handlers under `app/api/**` are unchanged `Request`/`Response` functions. **Session browsing** (read-only): list from `lib/session-reader.ts` (SDK-free, light); transcripts from `lib/session-entries.ts` (SDK, heavy). **Sending a message**: `startRpcSession()` (`lib/rpc-session-start.ts`) creates an AgentSession in the heavy runtime.

---

## File Map

Key modules only — for anything else, search the tree.

```
app/api/
  sessions/route.ts + [id]/route.ts + [id]/context/route.ts(?leafId=)   list / manage / per-leaf context
  agent/new | agent/[id] | agent/[id]/events | agent/running            create / command / SSE / running ids
  auth/{all-providers, providers, api-key/[p], login/[p], logout/[p]}   key + OAuth flows
  models | models-config(+ /test)                                       list + ~/.raincode/models.json + test
  cwd/validate | default-cwd | files/[...path] | home | worktrees       fs helpers
  memory-review | skills(+ /install, /search)                           background review + skills

lib/
  rpc-manager.ts            façade — re-exports wrapper / registry / startRpcSession
  rpc-session-wrapper.ts    AgentSessionWrapper (send, fork destroy, events)
  rpc-session-commands.ts   RPC send switch
  rpc-registry.ts           globalThis session registry + idle timeout
  rpc-session-start.ts      startRpcSession() — creates AgentSession in the heavy runtime
  rpc-session-tool-adoption.ts  startRpcSession toolNames → allow-list seed
  api-transport.ts          single transport owner (apiFetch / apiStream)
  session-reader.ts         SessionManager wrappers + path cache + buildSessionContext adapter
  session-tool-repair.ts    append error toolResults for trailing unmatched tool calls
  normalize.ts              normalizeToolCalls() — file-format vs our types field mismatch
  conversation-nodes.ts / session-projections.ts   assembleTranscript / fold todos/title/tokens
  tool-presentation.ts + tool-presenters/          tool cards (SDK-free exact-name presenters)
  pty-sessions.ts / background-jobs.ts / agent-job-tools.ts   PTY registry + job state machine + job tools
  builtin-extensions.ts + first-party/ + ensure-builtin-packages.ts   extension registration (no jiti)
  browser-bridge.ts / agent-browser-tool.ts / desktop-browser.ts      built-in browser (see Traps)
  file-access.ts            allowed file roots for /api/files and worktrees
  worktree.ts               project/worktree resolution + git worktree ops
  ephemeral-context.ts      state-only context messages (memory recall, mode brief) — never persisted
  memory-review.ts          every-10th-turn utility-model transcript review → retainMemoryFact
  literal-edit.ts + file-observations.ts + agent-edit-tool.ts         edit engine (rule 18)
  tool-presets.ts           FULL_TOOL_NAMES + getFullToolNames()
  overlay-scrollbars.ts     floating scrollbar thumbs for [data-overlay-scroll] (native bars width-0
                            app-wide); "gutter" parks thumb in sidebar seam; inset-top/-bottom in view
  github.ts / lsp-health.ts / web-settings.ts / agent-client.ts / draft-store.ts / file-paths.ts /
  markdown.ts / npx.ts / pi-types.ts / types.ts                       small helpers, one concern each

components/   AppShell (layout+tabs) · SessionSidebar (tree+FileExplorer) · ChatWindow (chat+sound)
  ChatInput · MessageView · conversation/Transcript (windowed) · BranchNavigator · ChatMinimap
  ModelsConfig (re-export; impl in models-config/) · SkillsConfig · app-shell/BrowserPanel (owns
  native-view attach/detach) · FileExplorer/FileViewer/FileIcons · TabBar · MarkdownBody · api-file-media

hooks/        useAgentSession (messages+streaming+SSE+fork/reconcile) · useAudio (completion sound)
  useApiObjectUrl (blob bridge for /api element URLs) · useDragDrop · useIsMobile · useTheme
```

---

## Key Design Decisions & Traps

### AgentSession lifecycle (`lib/rpc-manager.ts`)
One `AgentSessionWrapper` per session id in `globalThis.__raincodeSessions` (`globalThis` survives Next.js hot-reload; a module Map does not). Idle timeout 10 min; concurrent `startRpcSession()` calls share one start Promise (`globalThis.__raincodeStartLocks`).

### Background subagents never block the parent turn
`run_in_background` returns immediately; the parent turn ends normally. Single delivery path (`lib/first-party/subagents/delivery.ts`): collected non-blockingly at the next `agent_end` while busy, or via budgeted wake (`followUp` + `triggerTurn`, `MAX_CONSECUTIVE_WAKES = 3`, refilled by user input) while idle; at-most-once via `registry.claimReport`. **No poller, `isRunning()` check, or blocking wait.** A child `report` is a separate parent message (`subagent-report`), not a second settlement path.

- `settle` (registry.ts, first-wins) is the only transition flip point — also pumps the concurrency queue; per-child prompt turns serialize through a promise-chain lock, so `send_message`/`resume` can't interleave.
- After a turn the child stays resident for `send_message`/`resume`; destruction only via `kill_subagent` / parent Stop (interrupts turns, keeps residency) / teardown. One-shot children (`subagent_fork`, `background_mode: "one-shot"`) dispose on settle.
- Teardown is the single `wrapper.onDestroy` path (`teardownSubagentsForSession`, wired in `rpc-session-start.ts`) — covers `shutdown()`, `destroy()`, DELETE, fork.
- Depth is real (`MAX_SUBAGENT_DEPTH = 3`): factory carries it, descriptor persists it, hydrate keeps it monotone.
- Child failures surface as `error` status + `isError` tool results — never swallowed into "completed".
- Child transcripts open via `?parent=` on GET `/api/sessions/[id]`; human follow-up via RPC `subagent_followup` on the parent — do not list `tasks/` in the sidebar or point `ChatWindow` at a child.

### Background bash jobs (deepseek-harness parity)
`bash background: true` spawns a PTY (`lib/pty-sessions.ts`) + registers a job (`lib/background-jobs.ts`, single owner of `running | completed | killed`). 2.5s startup window: a crash inside it returns the real exit code inline (notice claimed); a survivor detaches with a job id (`bash-N`). Nonzero exits settle as `completed` — only `job_kill` / teardown settle as `killed`. Completion notices share the subagent delivery path (`turn-delivery.ts` + `jobs-notify.ts`), at-most-once via `claimJobReport`.

- Agent tools: `job_output` (absolute-offset incremental PTY read, bounded `wait`), `job_list`, `job_kill`. Cap `MAX_BACKGROUND_JOBS_PER_SESSION = 8` rejects instead of queueing.
- Three teardown paths, all through `destroyPtySession`: `job_kill`; `wrapper.onDestroy` → `teardownJobsForSession`; app quit → `destroyAllPtySessions()` from `daemon/ipc-host.mjs` (SIGTERM, SIGKILL after 3s; sweep waits out the 1.5s kill grace).
- No idle timer in `pty-sessions.ts` (it killed quiet dev servers); `pruneIfNeeded` only reaps exited corpses — a full board of live sessions rejects the create.
- `destroyPtySession` removes the registry row first, keeps listeners until the exit event lands — per-session SSE closes cleanly and jobs settle.

### Fork must destroy the wrapper immediately
`AgentSession.fork()` **mutates the wrapper in-place** — after fork, `inner.sessionId` is the *new* id. A wrapper left in the registry under the old id corrupts the `parentSession` chain on subsequent forks. **Fix**: `send("fork")` captures `newSessionId`, then calls `this.destroy()` before returning; the next request reloads a clean AgentSession from file.

### Two kinds of branching — don't confuse them
- **Fork** (Fork button on user message): new independent `.jsonl` file, shown as a sidebar child via the `parentSession` header field.
- **In-session branch** (Continue / BranchNavigator): `navigate_tree` within the same file; entries share `parentId`. Switching calls `/api/sessions/[id]/context?leafId=`.

### Built-in browser (main-process `WebContentsView` pool)
- Electron's own Chromium — no bundled Playwright, no remote-debugging port. Pool in `electron/browser-pool.js`, keyed by opaque viewId (session id; `"<sessionId>/<tab>"` for extra tabs; `"scratch"` for the no-session panel); all views share `persist:raincode-browser` so logins survive. Session teardown prefix-destroys the tab tree.
- Reverse IPC reuses the child channel: heavy → `{t:"browser"}` → main → `{t:"browser-res"}` (see `runtime-host.js` header). Heavy-only; the light runtime must never drive UI. No second transport.
- At most one view attached; the native view paints **above** the DOM, so `BrowserPanel` detaches whenever hidden/suspended (tab switch, panel close, resize drag, viewer modal, settings). Never leave it attached while covered.
- Agent interaction is snapshot-by-ref (`data-rc-ref` re-tagged per snapshot); refs go stale on navigation — by design, the tool says to re-snapshot.
- Every view has a CDP debugger from creation (`Runtime`/`Log`/`Network`), capturing console+exceptions (500) and network (300) into per-view ring buffers, reset on main-frame navigation. The agent reads them via the tool's `console`/`network`/`response_body` actions (seq-based); capture is the pool's job, formatting the tool's. Side effect: DevTools cannot attach to a pooled view.
- View teardown hangs off `wrapper.onDestroy` in `rpc-session-start.ts` — no separate view lifecycle.

### MCP disable/delete takes effect on the next tool call
`findTool`/`listTools`/`status` first call `pruneStaleServers()` (`lib/first-party/mcp/runtime.ts`): a server disabled/deleted mid-session is disconnected and vanishes immediately — no `/reload`. The registered prompt copy is a session-start snapshot (new names appear after `/reload`), so keep `mcp.reloadHint`.

### Session files can be fully rewritten
`parentSession` in the header is **display metadata only** — zero effect on chat content. Safe to `writeFileSync` the whole file (used when cascade-reparenting children on delete).

### ToolCall field normalization
Pi stores toolCalls as `{type:"toolCall", id, name, arguments}` but `ToolCallContent` uses `{toolCallId, toolName, input}`. `normalizeToolCalls()` (`lib/normalize.ts`) handles both — called in `session-reader.ts` (file load) and `useAgentSession.handleAgentEvent()` (streaming).

### Chat scroll follow
Owned by `use-stick-to-bottom` — `useAgentSession` creates it `{ initial: "instant", resize: "instant" }` and exposes `stickToBottom`/`resumeStickToBottom`/`bindScrollContainer`/`chatContentRef`/`stopScroll`/`stickScrollToBottom`. At-bottom threshold 70px; escape on upward scroll/wheel only; auto re-attach scrolling down (rule 12: no ad-hoc `scrollTop` writers besides settle / pagination / jump ticks / scrollbar thumb).

Cold load (ChatWindow): first paint mounts `FIRST_PAINT_RENDER_ITEMS` (20) items, backfills to `VISIBLE_PAGE_SIZE` next rAF in `startTransition`; a settle loop (`stopScroll()` + glue `scrollTop = scrollHeight` per rAF until stable 2 frames, 15-frame cap, then `scrollToBottom("instant")`) parks at the true bottom on the empty→non-empty flip, aborting if the user scrolls up. `.chat-message-item` uses `content-visibility: auto`, but the last `LIVE_TAIL_RENDER_ITEMS` (6) get `is-live` and are never virtualized — a growing row remembered at a stale height would drift the scroll lock.

### Session / model / tool defaults
- **Tools**: every session uses `getFullToolNames()` (`toolNames[]` on `POST /api/agent/new`, `set_tools` on mount). Fully disabled (`toolNames = []`) → empty allow-list + forced `agent.state.systemPrompt = ""` after startup/reload/discovery.
- **Model default**: `GET /api/models` → `defaultModel` prefers `raincode.json` → `modelRoles.default`, then `~/.raincode/settings.json`; `ChatWindow` pre-selects on mount.
- **SSE reconnect**: on `ChatWindow` mount, `GET /api/agent/[id]`; if `state.isStreaming`, SSE reconnects automatically (`thinkingLevel`, `isCompacting` also sync from this response).
- **Compaction**: pi emits `compaction_start`/`compaction_end`; manual compact is a blocking POST — button stays disabled until it returns.
- **Running state**: sidebar polls `GET /api/agent/running` while visible (`getRunningRpcSessionIds()`, no pub/sub). Active runs also reconcile via slow-interval + `visibilitychange`/`online` GETs (rule 9: no new poller). Monotonic run id; stale SSE/reconcile must no-op.

### Model roles / Git Review / project memory (Phase A)
- **Roles** (`default`/`smol`/`plan`) live in `~/.raincode/raincode.json` via `lib/web-settings.ts` + Settings UI; changing them rewrites managed agent frontmatter (`Explore`/`Plan`/`Reviewer`) via `syncAgentModelsFromRoles()`.
- **Git Review**: `POST /api/git/review` builds a prompt; GitPanel starts a session with the plan-role model + managed `Reviewer` subagent; assistant JSON → `ReviewSummaryCard`.
- **Edit (literal-match)**: `createRainCodeEditToolDefinition` (`lib/agent-edit-tool.ts` → `lib/literal-edit.ts`) implements rule 18; uniqueness errors report match count + lines; JS/TS parse-checked before write.
- **LSP health**: `lib/lsp-health.ts` + `GET /api/lsp?cwd=`; agent tool `lsp({ action })` (servers|hover|definition|references|rename) with install hints; TS/JS keeps built-in fallback.
- **GitHub thin layer**: `lib/github.ts` + agent tool `github` (gh CLI, read-only). Virtual paths `pr://N`, `pr://N/diff`, `issue://N` work via `read` / `github({action:"read"})`. API: `GET/POST /api/github`.
- **Project memory**: store under `~/.raincode/project-memory/<key>/facts.jsonl`, hard char budget (`projectBudgetChars` 4000; usage = Σ text.length + 20/fact); overflow rejects with entries + consolidate instruction. `memory_retain` has atomic `operations[]` batch (all-or-nothing); `memory_recall` searches; `memory_reflect` is heuristic + optional utility-model synthesis. Auto-inject owner is `selectMemoryInjectFacts` (top-K + maxInjectChars) → `appendSystemPromptOverride` in `startRpcSession`, picks frozen on the wrapper as `injectedMemoryFacts`. Per-prompt, `send("prompt")` injects query-relevant recall (`buildQueryMemoryContext`, ≤800 chars, deduped vs the frozen snapshot) + the mode brief as **ephemeral state-only messages** (`lib/ephemeral-context.ts`, one per customType, replaced in place). **MUST NOT** use `sendCustomMessage({ deliverAs: "nextTurn" })` — the SDK persists those into the .jsonl and replays them forever; `startRpcSession` prunes such legacy blocks.
- **Background memory review** (`lib/memory-review.ts` + `POST /api/memory-review`): fired fire-and-forget after every agent-end; a per-session counter (`globalThis.__raincodeMemoryReviewTurnCounts`) runs the real review only every 10th user turn. Store cwd comes from the session file's own header (caller's cwd can race). Full store short-circuits `budget-full`. One utility-model JSON completion (smol → plan → default) over ~10 snippets (~6KB); facts go through `retainMemoryFact` (secret guard / dedupe / budget).

### Worktrees and project grouping
`lib/worktree.ts` resolves linked worktree top-levels back to the main repo `projectRoot`, attached to each `SessionInfo` so one repo groups together. Ops via `/api/worktrees` under the same allowed-root rules as `/api/files`. New worktrees: `<repoRoot>-worktrees/<sanitized-branch>`; existing branches reused, else `git worktree add -b`. Dirty removal → `409 { dirty: true }`, retry with `force`. Sessions whose cwd lost its worktree are inferred back into the main project.

### File access allow-list
`/api/files` is not a general filesystem browser: allowed roots come from session cwds, their project roots, `~/raincode-*`, and explicit `allowFileRoot()` calls. `/api/cwd/validate`, `/api/default-cwd`, `/api/worktrees` call `allowFileRoot()` when they open a new location.

### Built-in packages and skills
- First-party factories (`todo`, `ask_user_question`, permission, subagents, MCP) under `lib/first-party/` register via `extensionFactories` (no jiti); centralized in `lib/builtin-extensions.ts` → `startRpcSession`. Nothing installs into `~/.raincode/npm` on boot; `ensure-builtin-packages.ts` only migrates legacy `settings.json` `packages[]` + prewarms.
- Compaction uses the SDK native path (`pi-better-compaction` not shipped).
- Extension runtime UI (confirm/select/input/editor, widgets, status chips, panels) is handled by `rpc-manager` + `ChatWindow`; no package manager UI.
- `/api/skills` uses `DefaultResourceLoader` (settings paths, package skills, project `.agents/skills` listed as the runtime sees them). Toggling edits only the `disable-model-invocation` frontmatter key — keep it surgical. Install shells `npx skills add ... --agent pi`.

### Auth and model config
`ModelsConfig` merges `~/.raincode/models.json` with pi `AuthStorage`/`ModelRegistry` auth status. OAuth/device-code/manual-code stream via `GET /api/auth/login/[provider]`; manual codes POST back with a short-lived token in `globalThis.__raincodeLoginCallbacks`. API-key routes use `AuthStorage`; status endpoints never return the raw key. Model test route is `app/api/models-config/test/route.ts` (`app/api/models/test/` does not exist).

### Completion sound
`hooks/useAudio.ts`: toggle in `localStorage` `pi-sound-enabled`, one reused `AudioContext`. Autoplay policy requires gesture unlock — `ChatInput` unlocks from interactive controls; `ChatWindow` plays from `onAgentEnd`.


## Pi Session File Format

Location: `~/.raincode/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`

```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}
{"type":"model_change","id":"<8hex>","parentId":null,"provider":"zenmux","modelId":"claude-sonnet-4-6","timestamp":"..."}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"user|assistant|toolResult","content":...}}
{"type":"compaction","id":"<8hex>","parentId":"<8hex>","summary":"...","firstKeptEntryId":"<8hex>","tokensBefore":N}
{"type":"session_info","id":"...","parentId":"...","name":"user-defined name"}
```

`entryIds[]` in `SessionContext` is parallel to `messages[]` — maps each message back to its `.jsonl` entry id, used for fork and navigate_tree.

---

## CSS Variables (`app/globals.css`)

```
--bg --bg-panel --bg-hover --bg-selected --border --bg-subtle
--text --text-muted --text-dim
--accent --accent-hover --accent-fg --user-bg --assistant-bg --tool-bg
--success --destructive --ring
--success-bg/--success-border --destructive-bg/--destructive-border   (status tints)
--diff-add-bg --diff-del-bg --diff-hunk-bg                            (single diff recipe)
--overlay-bg --shadow-sm --shadow-md                                  (per-theme values)
--radius-xs(4) --radius-sm(6) --radius-md(8) --radius-lg(10) --radius-xl(16) --radius-pill(999)
--font-mono
```

**Styling rules**: no raw hex/rgba or numeric borderRadius in components — use the tokens. Shared classes (end of globals.css): `.btn-primary` `.btn-ghost` `.btn-danger` `.icon-btn` (`--icon-btn-size`) `.input-base` `.menu-card` `.modal-backdrop` `.modal-shell`. Font scale: 11 micro / 12 tool+meta / 13 secondary / 14 body; code 12.5. Micro-headers: `letterSpacing: 0.06em`; headings `fontWeight: 600`.
