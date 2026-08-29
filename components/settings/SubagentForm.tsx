/**
 * Create / edit a custom subagent definition (agents/*.md frontmatter + body).
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { useLocale } from "@/hooks/useLocale";
import type { SubagentListItem, ToolsPreset } from "@/lib/subagent-files";
import type { WebSettingsModelOption } from "@/lib/web-settings-store";
import { Icon } from "../Icon";
import { SettingsToggle } from "../SettingsToggle";
import { ModelSelect, SettingsPageHeading } from "./settings-ui";

export type SubagentDraft = {
  originalName?: string;
  name: string;
  color: string;
  model: string;
  description: string;
  toolsPreset: ToolsPreset;
  tools: string;
  systemPrompt: string;
  promptMode: "append" | "replace";
  injectAgentsMd: boolean;
};

/** Tag palette keys — rendered via --agent-tag-* tokens in globals.css. */
export const AGENT_TAG_COLORS = [
  "yellow",
  "red",
  "orange",
  "green",
  "cyan",
  "blue",
  "purple",
  "pink",
] as const;

export function agentTagColorVar(color: string | undefined): string {
  const key = AGENT_TAG_COLORS.includes((color ?? "") as (typeof AGENT_TAG_COLORS)[number])
    ? (color as (typeof AGENT_TAG_COLORS)[number])
    : AGENT_TAG_COLORS[0];
  return `var(--agent-tag-${key})`;
}

export function emptySubagentDraft(): SubagentDraft {
  return {
    name: "",
    color: AGENT_TAG_COLORS[0],
    model: "",
    description: "",
    toolsPreset: "all",
    tools: "",
    systemPrompt: "",
    promptMode: "replace",
    injectAgentsMd: true,
  };
}

export function draftFromItem(item: SubagentListItem): SubagentDraft {
  return {
    originalName: item.name,
    name: item.name,
    color: item.color ?? AGENT_TAG_COLORS[0],
    model: item.model ?? "",
    description: item.description,
    toolsPreset: item.toolsPreset,
    tools: item.tools ?? "",
    systemPrompt: item.systemPrompt,
    promptMode: item.promptMode,
    injectAgentsMd: item.injectAgentsMd === true,
  };
}

export function draftToPayload(draft: SubagentDraft, scope: "user" | "project", cwd?: string | null): Record<string, unknown> {
  return {
    originalName: draft.originalName,
    name: draft.name.trim(),
    color: draft.color,
    model: draft.model.trim(),
    description: draft.description.trim(),
    toolsPreset: draft.toolsPreset,
    tools: draft.tools,
    systemPrompt: draft.systemPrompt.trim(),
    promptMode: draft.promptMode,
    injectAgentsMd: draft.injectAgentsMd,
    enabled: true,
    scope,
    ...(cwd ? { cwd } : {}),
  };
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <span className="settings-row-title">{children}</span>;
}

export function SubagentForm({
  mode,
  initial,
  saving,
  error,
  models,
  loadingModels,
  onBack,
  onSave,
  onDelete,
}: {
  mode: "add" | "edit";
  initial: SubagentDraft;
  saving: boolean;
  error: string | null;
  models: WebSettingsModelOption[];
  loadingModels: boolean;
  onBack: () => void;
  onSave: (draft: SubagentDraft) => void;
  onDelete?: () => void;
}) {
  const { t } = useLocale();
  const rootRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<SubagentDraft>(initial);
  const canSave = Boolean(draft.name.trim()) && Boolean(draft.description.trim()) && Boolean(draft.systemPrompt.trim());

  useEffect(() => {
    rootRef.current?.scrollIntoView({ block: "start" });
  }, []);

  const set = (patch: Partial<SubagentDraft>) => setDraft((prev) => ({ ...prev, ...patch }));

  return (
    <div className="mcp-form" ref={rootRef}>
      <button type="button" className="btn-ghost btn-compact" onClick={onBack}>
        <Icon icon={ChevronLeft} size={12} strokeWidth={1.8} />
        {t("skills.back")}
      </button>

      <SettingsPageHeading
        title={mode === "edit" ? t("subagents.editAgent") : t("subagents.newAgent")}
        action={onDelete ? (
          <button
            type="button"
            className="btn-ghost btn-compact"
            style={{ color: "var(--destructive)" }}
            onClick={onDelete}
            disabled={saving}
          >
            {t("subagents.delete")}
          </button>
        ) : undefined}
      />

      {error && (
        <div className="settings-card-empty" role="alert" style={{ color: "var(--destructive)", marginBottom: 12 }}>
          {error}
        </div>
      )}

      <div className="settings-card" style={{ marginBottom: 16, padding: "12px 14px" }}>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 12 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 6, flex: "1 1 200px" }}>
            <FieldLabel>{t("subagents.fieldName")}</FieldLabel>
            <input
              className="input-base input-mono"
              value={draft.name}
              placeholder="code-reviewer"
              disabled={mode === "edit"}
              onChange={(e) => set({ name: e.target.value })}
            />
          </label>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <FieldLabel>{t("subagents.fieldColor")}</FieldLabel>
            <div
              role="radiogroup"
              aria-label={t("subagents.fieldColor")}
              style={{ display: "flex", gap: 6, alignItems: "center", flex: 1 }}
            >
              {AGENT_TAG_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  role="radio"
                  aria-checked={draft.color === color}
                  aria-label={color}
                  title={color}
                  onClick={() => set({ color })}
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: "var(--radius-pill)",
                    background: agentTagColorVar(color),
                    border: draft.color === color ? "2px solid var(--text)" : "1px solid transparent",
                    cursor: "pointer",
                    padding: 0,
                  }}
                />
              ))}
            </div>
          </div>
          <label style={{ display: "flex", flexDirection: "column", gap: 6, flex: "1 1 200px" }}>
            <FieldLabel>{t("subagents.fieldModel")}</FieldLabel>
            <ModelSelect
              value={draft.model}
              models={models}
              loading={loadingModels}
              placeholder={t("subagents.inheritModel")}
              ariaLabel={t("subagents.fieldModel")}
              unavailableLabel={t("subagents.modelUnavailable")}
              onChange={(value) => set({ model: value })}
            />
          </label>
        </div>
        <label style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
          <FieldLabel>{t("subagents.fieldDescription")}</FieldLabel>
          <input
            className="input-base"
            value={draft.description}
            placeholder={t("subagents.descriptionPlaceholder")}
            maxLength={500}
            onChange={(e) => set({ description: e.target.value })}
          />
        </label>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <FieldLabel>{t("subagents.fieldTools")}</FieldLabel>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <select
              className="input-base"
              value={draft.toolsPreset}
              onChange={(e) => set({ toolsPreset: e.target.value as ToolsPreset })}
              aria-label={t("subagents.fieldTools")}
              style={{ width: 170 }}
            >
              <option value="all">{t("subagents.toolsAll")}</option>
              <option value="readonly">{t("subagents.toolsReadonly")}</option>
              <option value="none">{t("subagents.toolsNone")}</option>
              <option value="custom">{t("subagents.toolsCustom")}</option>
            </select>
            {draft.toolsPreset === "custom" && (
              <input
                className="input-base input-mono"
                value={draft.tools}
                placeholder="read, bash, grep"
                style={{ flex: 1, minWidth: 180 }}
                onChange={(e) => set({ tools: e.target.value })}
              />
            )}
            <span className="settings-row-desc" style={{ fontSize: 11, color: "var(--text-dim)" }}>
              {t("subagents.toolsHint")}
            </span>
          </div>
        </div>
      </div>

      <div className="settings-card" style={{ marginBottom: 16 }}>
        <div className="settings-row is-stacked">
          <span className="settings-row-title">{t("subagents.fieldPromptMode")}</span>
          <div className="settings-segmented">
            <button
              type="button"
              className={`chrome-btn${draft.promptMode === "replace" ? " is-active" : ""}`}
              aria-pressed={draft.promptMode === "replace"}
              onClick={() => set({ promptMode: "replace" })}
            >
              {t("subagents.promptReplace")}
            </button>
            <button
              type="button"
              className={`chrome-btn${draft.promptMode === "append" ? " is-active" : ""}`}
              aria-pressed={draft.promptMode === "append"}
              onClick={() => set({ promptMode: "append" })}
            >
              {t("subagents.promptInherit")}
            </button>
          </div>
        </div>
        <div className="settings-row is-stacked">
          <span className="settings-row-title">{t("subagents.fieldSystemPrompt")}</span>
          <textarea
            className="input-base"
            value={draft.systemPrompt}
            placeholder={t("subagents.systemPromptPlaceholder")}
            rows={6}
            onChange={(e) => set({ systemPrompt: e.target.value })}
          />
        </div>
        <div className="settings-row" style={{ borderBottom: "none" }}>
          <div className="settings-row-copy">
            <div className="settings-row-title">{t("subagents.injectAgentsMd")}</div>
            <div className="settings-row-desc" style={{ fontSize: 11, color: "var(--text-dim)" }}>
              {draft.promptMode === "append"
                ? t("subagents.injectAgentsMdInheritHint")
                : t("subagents.injectAgentsMdHint")}
            </div>
          </div>
          <SettingsToggle
            enabled={draft.promptMode === "replace" && draft.injectAgentsMd}
            disabled={draft.promptMode === "append"}
            onChange={(next) => set({ injectAgentsMd: next })}
          />
        </div>
      </div>

      <div className="mcp-form-actions" style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" className="btn-ghost btn-compact" onClick={onBack} disabled={saving}>
          {t("common.cancel")}
        </button>
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
