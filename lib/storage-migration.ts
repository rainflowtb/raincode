/**
 * One-time localStorage rebrand migration: copies legacy `pi-*` keys to their
 * `raincode-*` names. Idempotent and one-way (old keys are removed after copy).
 * Removal condition: delete this module and its boot-script invocation one
 * release after the RainCode rebrand ships.
 */

/** Inline-script-safe source: also embedded verbatim in app/layout.tsx and desktop/index.html. */
export const STORAGE_KEY_MIGRATIONS: ReadonlyArray<readonly [string, string]> = [
  ["pi-theme-mode", "raincode-theme-mode"],
  ["pi-theme", "raincode-theme"],
  ["pi-appearance", "raincode-appearance"],
  ["pi-locale", "raincode-locale"],
  ["pi-sound-enabled", "raincode-sound-enabled"],
  ["pi-terminal-font", "raincode-terminal-font"],
  ["pi-explorer-open", "raincode-explorer-open"],
  ["pi-right-panel-width", "raincode-right-panel-width"],
  ["pi-sidebar-width", "raincode-sidebar-width"],
  ["pi-web:unread-session-ids", "raincode:unread-session-ids"],
  ["pi-web-ext-widget-open", "raincode-ext-widget-open"],
];

export function migrateLegacyStorageKeys(): void {
  if (typeof window === "undefined") return;
  try {
    for (const [legacy, next] of STORAGE_KEY_MIGRATIONS) {
      const value = window.localStorage.getItem(legacy);
      if (value !== null && window.localStorage.getItem(next) === null) {
        window.localStorage.setItem(next, value);
      }
      if (value !== null) window.localStorage.removeItem(legacy);
    }
  } catch {
    // storage unavailable (private mode) — skip migration
  }
}
