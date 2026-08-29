# State Ownership Inventory

Every piece of cross-component / cross-client writable state, its single owner,
and its one invalidation path. Rules 21/22 in `AGENTS.md` govern additions:
declare the owner here first, and route process-side-effectful writes to the
runtime that owns the state.

Last swept: 2026-08 (sync audit — 9 desync fixes + revision-push channel).

## Renderer-owned (single cached snapshot, subscription)

| State | Owner | Invalidation path |
|---|---|---|
| Web settings (raincode.json) | `lib/web-settings-store.ts` | File watcher push (`lib/settings-revision.ts` → SSE `/api/web-settings/events`) → `refreshWebSettings`; `saveWebSettings` applies PUT responses directly |
| Permission policy yoloMode | server file; renderer reads via `/api/permissions` + store `agentMode` | Same watcher (policy filename) → store → `PermissionsSettingsPanel` reload effect |
| Appearance prefs | `lib/appearance-store.ts` | `setAppearanceSnapshot` at write time (SettingsPage `patchPref`) |
| App update info | `lib/app-update-store.ts` | `setAppUpdateInfo` / `checkAppUpdate` |
| Project memory facts revision | `lib/project-memory-store.ts` | `invalidateProjectMemory()` at every write site (settings panel + agent-end) |
| GitHub account status | server `~/.raincode/accounts.json`; renderer signal | `lib/accounts-revision-store.ts` — `invalidateAccounts()` on connect/disconnect |
| Agent mode (composer ↔ sessions) | `~/.raincode/raincode.json` via store | Same settings watcher; live wrappers sync via heavy `set_mode` / `?sync=1` |

## Server-owned process-local (registry / pools)

| State | Owning runtime | Cross-process access |
|---|---|---|
| RPC session registry (`__raincodeSessions`) | heavy | Effect-ful writes pinned heavy: `?effects=1`, `?sync=1`, `set_mode` RPC |
| PTY sessions + background jobs | heavy | `/api/cwd/pty*` pinned heavy |
| Debug session pool | heavy | `/api/debug/sessions` pinned heavy |
| Models cache (`__raincodeModelsCache`) | heavy | `invalidateModelsCache` at write sites; renderer bypasses with `?fresh=1` |
| Session list cache + path cache | light | `invalidateSessionListCache` at write sites; renderer bypasses with `?fresh=1` |
| Web settings read cache (mtime+size) | both, per-process | write-after-prime in `writeWebSettings` |

## Known residual gaps (accepted, by decision)

- **Session list across LAN devices**: no push channel (directory watch on
  `sessions/` is too noisy); sidebar refreshes on local activity and the
  running-badge poll. Revisit if LAN gains multi-writer prominence.
- **models.json / auth.json across LAN devices**: 60 s heavy TTL + `?fresh=1`
  on local mutations; no revision push. Same revisit condition.
- **LAN key rotation from a LAN client**: main-process LAN server re-reads the
  key only at `lan-apply`; a LAN client changing `lanAccessKey` needs a desktop
  `lan-apply` (or restart) to take effect.

## Fix log (2026-08 sync audit)

1. SettingsPage `prefs` + model refs forked from store → now derived via `applySettingsSnapshot`.
2. GeneralSettingsPanel `lanState` mount-time snapshot → re-read on `lanAccessEnabled` change.
3. Permissions YOLO toggle wrote agentMode outside the store → watcher push is the single invalidation path.
4. TerminalPanel font mount-time snapshot → subscribes to store.
5. GitPanel login → AccountsSettingsPanel via `accounts-revision-store`.
6. Plugins MCP/Skills warm-mounted tabs → `active` prop reload on visibility.
7. `/api/permissions` + `PUT /api/web-settings` effects ran in light on an empty registry → query-pinned heavy.
8. `/api/debug/sessions` pool split → pinned heavy.
9. Memory-review turn counter leaked per session → cleared in the single `onDestroy` teardown.
