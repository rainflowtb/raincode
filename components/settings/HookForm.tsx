/**
 * Add / edit a lifecycle hook (event + matcher + shell command).
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { useLocale } from "@/hooks/useLocale";
import type { MessageKey } from "@/lib/i18n/messages";
import { Icon } from "../Icon";
import { SettingsPageHeading } from "./settings-ui";
import {
  HOOK_EVENTS,
  HOOK_MATCHER_EVENTS,
  HOOK_TIMEOUT_DEFAULT,
  type HookEvent,
  type HookListItem,
  type HookScope,
} from "@/lib/hooks-schema";

export type HookDraft = {
  id?: string;
  name: string;
  event: HookEvent;
  matcher: string;
  command: string;
  timeoutSeconds: number;
  enabled: boolean;
};

export function emptyHookDraft(): HookDraft {
  return {
    name: "",
    event: "tool_call",
    matcher: "",
    command: "",
    timeoutSeconds: HOOK_TIMEOUT_DEFAULT,
    enabled: true,
  };
}

export function draftFromHook(hook: HookListItem): HookDraft {
  return {
    id: hook.id,
    name: hook.name,
    event: hook.event,
    matcher: hook.matcher ?? "",
    command: hook.command,
    timeoutSeconds: hook.timeoutSeconds ?? HOOK_TIMEOUT_DEFAULT,
    enabled: hook.enabled !== false,
  };
}

export function draftToPayload(draft: HookDraft, scope: HookScope, cwd?: string | null): Record<string, unknown> {
  return {
    id: draft.id,
    name: draft.name.trim(),
    event: draft.event,
    matcher: draft.matcher.trim(),
    command: draft.command.trim(),
    timeoutSeconds: draft.timeoutSeconds,
    enabled: draft.enabled,
    scope,
    ...(cwd ? { cwd } : {}),
  };
}

const EVENT_LABEL_KEYS: Record<HookEvent, MessageKey> = {
  session_start: "hooks.eventSessionStart",
  before_agent_start: "hooks.eventBeforeAgentStart",
  tool_call: "hooks.eventToolCall",
  tool_result: "hooks.eventToolResult",
  agent_end: "hooks.eventAgentEnd",
  session_before_compact: "hooks.eventBeforeCompact",
  session_compact: "hooks.eventCompact",
  session_shutdown: "hooks.eventShutdown",
};

export function hookEventLabelKey(event: HookEvent): MessageKey {
  return EVENT_LABEL_KEYS[event];
}

export function HookForm({
  mode,
  initial,
  saving,
  error,
  onBack,
  onSave,
  onDelete,
}: {
  mode: "add" | "edit";
  initial: HookDraft;
  saving: boolean;
  error: string | null;
  onBack: () => void;
  onSave: (draft: HookDraft) => void;
  onDelete?: () => void;
}) {
  const { t } = useLocale();
  const rootRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<HookDraft>(initial);
  const canSave = Boolean(draft.name.trim()) && Boolean(draft.command.trim());
  const usesMatcher = (HOOK_MATCHER_EVENTS as readonly string[]).includes(draft.event);

  useEffect(() => {
    rootRef.current?.scrollIntoView({ block: "start" });
  }, []);

  const set = (patch: Partial<HookDraft>) => setDraft((prev) => ({ ...prev, ...patch }));

  return (
    <div className="mcp-form" ref={rootRef}>
      <button type="button" className="btn-ghost btn-compact" onClick={onBack}>
        <Icon icon={ChevronLeft} size={12} strokeWidth={1.8} />
        {t("skills.back")}
      </button>

      <SettingsPageHeading
        title={mode === "edit" ? draft.name.trim() || t("hooks.edit") : t("hooks.newHook")}
        action={onDelete ? (
          <button
            type="button"
            className="btn-ghost btn-compact"
            style={{ color: "var(--destructive)" }}
            onClick={onDelete}
            disabled={saving}
          >
            {t("hooks.delete")}
          </button>
        ) : undefined}
      />

      {error && (
        <div className="settings-card-empty" role="alert" style={{ color: "var(--destructive)", marginBottom: 12 }}>
          {error}
        </div>
      )}

      <div className="settings-card" style={{ marginBottom: 16 }}>
        <label className="settings-row is-stacked">
          <span className="settings-row-title">{t("hooks.name")}</span>
          <input
            className="input-base"
            value={draft.name}
            placeholder={t("hooks.namePlaceholder")}
            onChange={(e) => set({ name: e.target.value })}
          />
        </label>
        <div className="settings-row is-stacked">
          <span className="settings-row-title">{t("hooks.event")}</span>
          <select
            className="input-base"
            value={draft.event}
            onChange={(e) => set({ event: e.target.value as HookEvent })}
            aria-label={t("hooks.event")}
          >
            {HOOK_EVENTS.map((event) => (
              <option key={event} value={event}>{t(hookEventLabelKey(event))}</option>
            ))}
          </select>
        </div>
        {usesMatcher && (
          <label className="settings-row is-stacked">
            <span className="settings-row-title">{t("hooks.matcher")}</span>
            <input
              className="input-base input-mono"
              value={draft.matcher}
              placeholder={t("hooks.matcherPlaceholder")}
              onChange={(e) => set({ matcher: e.target.value })}
            />
            <span className="settings-row-desc" style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
              {t("hooks.matcherHint")}
            </span>
          </label>
        )}
      </div>

      <div className="settings-card" style={{ marginBottom: 16 }}>
        <label className="settings-row is-stacked">
          <span className="settings-row-title">{t("hooks.command")}</span>
          <textarea
            className="input-base input-mono"
            value={draft.command}
            placeholder={t("hooks.commandPlaceholder")}
            rows={4}
            onChange={(e) => set({ command: e.target.value })}
          />
        </label>
        <div className="settings-row is-stacked">
          <span className="settings-row-desc" style={{ fontSize: 11, color: "var(--text-dim)" }}>
            {t("hooks.commandHint")}
          </span>
        </div>
        <label className="settings-row">
          <span className="settings-row-title">{t("hooks.timeout")}</span>
          <input
            className="input-base input-mono"
            type="number"
            min={1}
            max={600}
            value={draft.timeoutSeconds}
            style={{ width: 96 }}
            onChange={(e) => {
              const parsed = Number(e.target.value);
              set({ timeoutSeconds: Number.isFinite(parsed) ? parsed : HOOK_TIMEOUT_DEFAULT });
            }}
          />
        </label>
        <div className="settings-row">
          <div className="settings-row-title">{t("hooks.enabled")}</div>
          <div className="settings-segmented">
            <button
              type="button"
              className={`chrome-btn${draft.enabled ? " is-active" : ""}`}
              aria-pressed={draft.enabled}
              onClick={() => set({ enabled: true })}
            >
              {t("hooks.enabledOn")}
            </button>
            <button
              type="button"
              className={`chrome-btn${!draft.enabled ? " is-active" : ""}`}
              aria-pressed={!draft.enabled}
              onClick={() => set({ enabled: false })}
            >
              {t("hooks.enabledOff")}
            </button>
          </div>
        </div>
      </div>

      <div className="mcp-form-actions">
        <button
          type="button"
          className="btn-primary btn-compact"
          disabled={saving || !canSave}
          onClick={() => onSave(draft)}
        >
          {saving ? t("common.saving") : t("common.save")}
        </button>
      </div>
    </div>
  );
}
