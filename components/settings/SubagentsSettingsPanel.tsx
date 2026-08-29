/**
 * Settings → Subagents: custom agent CRUD per scope plus a read-only view of
 * the managed built-in agents.
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, Plus, RefreshCw, Search } from "lucide-react";
import { useLocale } from "@/hooks/useLocale";
import type { MessageKey, TranslateParams } from "@/lib/i18n/messages";
import { apiFetch } from "@/lib/api-transport";
import type { SubagentListItem, SubagentListResult } from "@/lib/subagent-files";
import type { WebSettingsModelOption } from "@/lib/web-settings-store";
import { Icon } from "../Icon";
import { ConfirmDialog } from "../ConfirmDialog";
import { SettingsToggle } from "../SettingsToggle";
import { SettingsGroup, SettingsPageHeading, SettingsRow, SegmentedOption } from "./settings-ui";
import {
  SubagentForm,
  agentTagColorVar,
  draftFromItem,
  draftToPayload,
  emptySubagentDraft,
  type SubagentDraft,
} from "./SubagentForm";

type Scope = "user" | "project";
type FormState = { mode: "add" | "edit"; draft: SubagentDraft } | null;

function toolsBadgeInfo(item: SubagentListItem): { key: MessageKey; params?: TranslateParams } {
  if (item.toolsPreset === "all") return { key: "subagents.badgeAllTools" };
  if (item.toolsPreset === "none") return { key: "subagents.badgeNoTools" };
  const count = item.toolsPreset === "readonly" ? 5 : (item.tools ?? "").split(",").filter(Boolean).length;
  return { key: "subagents.toolsCount", params: { n: count } };
}

export function SubagentsSettingsPanel({
  cwd,
  models,
  loadingModels,
}: {
  cwd: string | null;
  models: WebSettingsModelOption[];
  loadingModels: boolean;
}) {
  const { t } = useLocale();
  const [scope, setScope] = useState<Scope>("user");
  const [data, setData] = useState<SubagentListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<FormState>(null);
  const [pendingDelete, setPendingDelete] = useState<SubagentListItem | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
      const res = await apiFetch(`/api/subagents${qs}`);
      const json = await res.json() as SubagentListResult & { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
      setData({ builtin: json.builtin ?? [], user: json.user ?? [], project: json.project ?? [], paths: json.paths ?? { user: "" } });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    void load();
  }, [load]);

  const scopeAgents = useMemo(
    () => (scope === "user" ? data?.user ?? [] : data?.project ?? []),
    [data, scope],
  );

  const visibleAgents = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return scopeAgents;
    return scopeAgents.filter((agent) =>
      agent.name.toLowerCase().includes(query)
      || agent.displayName.toLowerCase().includes(query)
      || agent.description.toLowerCase().includes(query),
    );
  }, [scopeAgents, search]);

  const visibleBuiltins = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return data?.builtin ?? [];
    return (data?.builtin ?? []).filter((agent) =>
      agent.name.toLowerCase().includes(query)
      || agent.displayName.toLowerCase().includes(query)
      || agent.description.toLowerCase().includes(query),
    );
  }, [data, search]);

  const toggle = async (agent: SubagentListItem) => {
    setBusyName(agent.name);
    setError(null);
    try {
      const res = await apiFetch("/api/subagents", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: agent.name, enabled: agent.enabled === false, scope: agent.scope, cwd: cwd ?? undefined }),
      });
      const json = await res.json() as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyName(null);
    }
  };

  const saveAgent = async (draft: SubagentDraft) => {
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch("/api/subagents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draftToPayload(draft, scope, cwd)),
      });
      const json = await res.json() as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
      setForm(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const removeAgent = async (agent: SubagentListItem) => {
    setBusyName(agent.name);
    setError(null);
    try {
      const res = await apiFetch("/api/subagents", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: agent.name, scope: agent.scope, cwd: cwd ?? undefined }),
      });
      const json = await res.json() as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
      setPendingDelete(null);
      setForm(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyName(null);
    }
  };

  const openAdd = () => {
    setForm({ mode: "add", draft: emptySubagentDraft() });
    setError(null);
  };

  const openEdit = (agent: SubagentListItem) => {
    setForm({ mode: "edit", draft: draftFromItem(agent) });
    setError(null);
  };

  const badge = (item: SubagentListItem) => {
    const info = toolsBadgeInfo(item);
    return (
      <span
        className="chrome-btn"
        style={{ fontSize: 11, padding: "1px 8px", pointerEvents: "none", color: "var(--text-muted)" }}
      >
        {t(info.key, info.params)}
      </span>
    );
  };

  const body = form ? (
    <SubagentForm
      mode={form.mode}
      initial={form.draft}
      saving={saving}
      error={error}
      models={models}
      loadingModels={loadingModels}
      onBack={() => {
        setForm(null);
        setError(null);
      }}
      onSave={(draft) => void saveAgent(draft)}
      onDelete={form.mode === "edit"
        ? () => {
            const agent = scopeAgents.find((a) => a.name === form.draft.originalName);
            if (agent) setPendingDelete(agent);
          }
        : undefined}
    />
  ) : (
    <>
      <SettingsPageHeading
        title={t("subagents.title")}
        description={t("subagents.description")}
      />

      <div
        role="toolbar"
        aria-label={t("subagents.title")}
        style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginBottom: 12 }}
      >
        <div className="settings-segmented">
          <SegmentedOption active={scope === "user"} label={t("subagents.scopeUser")} onClick={() => setScope("user")} />
          <SegmentedOption
            active={scope === "project"}
            label={t("subagents.scopeProject")}
            title={cwd ? undefined : t("subagents.projectNeedCwd")}
            onClick={() => setScope("project")}
          />
        </div>
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {t("subagents.installed")} <span style={{ color: "var(--text)" }}>{scopeAgents.length}</span>
        </div>
        <div style={{ flex: 1, minWidth: 120 }} />
        <div style={{ position: "relative", width: 220, maxWidth: "100%" }}>
          <span
            style={{
              position: "absolute",
              left: 8,
              top: "50%",
              transform: "translateY(-50%)",
              color: "var(--text-dim)",
              display: "inline-flex",
              pointerEvents: "none",
            }}
          >
            <Icon icon={Search} size={12} />
          </span>
          <input
            className="input-base"
            value={search}
            placeholder={t("subagents.search")}
            aria-label={t("subagents.search")}
            style={{ paddingLeft: 26 }}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <button
          type="button"
          className="icon-btn"
          aria-label={t("common.refresh")}
          onClick={() => void load()}
          disabled={loading}
        >
          <Icon icon={RefreshCw} size={13} />
        </button>
        <button type="button" className="btn-primary btn-compact" onClick={openAdd}>
          <Icon icon={Plus} size={12} strokeWidth={2} />
          {t("subagents.new")}
        </button>
      </div>

      {error && (
        <div className="settings-card-empty" role="alert" style={{ color: "var(--destructive)", marginBottom: 12 }}>
          {error}
        </div>
      )}

      {scope === "project" && !cwd ? (
        <div className="settings-card-empty" style={{ marginBottom: 16 }}>{t("subagents.projectNeedCwd")}</div>
      ) : (
        <SettingsGroup
          title={`${t("subagents.installed")} ${visibleAgents.length} ${t("subagents.items")}`}
        >
          {loading ? (
            <div className="settings-card-empty">{t("common.loading")}</div>
          ) : visibleAgents.length === 0 ? (
            search.trim() ? (
              <div className="settings-card-empty">{t("subagents.noMatches")}</div>
            ) : (
              <div
                style={{
                  border: "1px dashed var(--border)",
                  borderRadius: "var(--radius-lg)",
                  padding: "36px 16px",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 8,
                  textAlign: "center",
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600 }}>{t("subagents.emptyTitle")}</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("subagents.emptyDesc")}</div>
                <button
                  type="button"
                  className="btn-primary btn-compact"
                  style={{ marginTop: 8 }}
                  onClick={openAdd}
                >
                  <Icon icon={Plus} size={12} strokeWidth={2} />
                  {t("subagents.new")}
                </button>
              </div>
            )
          ) : (
            visibleAgents.map((agent) => {
              const disabled = agent.enabled === false;
              return (
                <SettingsRow
                  key={`${agent.scope}:${agent.name}`}
                  title={
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      <span
                        aria-hidden
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: "var(--radius-pill)",
                          background: agentTagColorVar(agent.color),
                          display: "inline-block",
                        }}
                      />
                      <span className="input-mono" style={disabled ? { color: "var(--text-dim)" } : undefined}>
                        {agent.name}
                      </span>
                      {badge(agent)}
                      {agent.model && (
                        <span style={{ fontSize: 11, color: "var(--text-dim)" }} className="input-mono">
                          {agent.model}
                        </span>
                      )}
                    </span>
                  }
                  description={agent.description}
                  onClick={() => openEdit(agent)}
                  action={
                    <SettingsToggle
                      enabled={!disabled}
                      loading={busyName === agent.name}
                      onChange={() => void toggle(agent)}
                    />
                  }
                />
              );
            })
          )}
        </SettingsGroup>
      )}

      <SettingsGroup
        title={`${t("subagents.builtin")} ${visibleBuiltins.length} ${t("subagents.items")}`}
        action={<span className="settings-row-desc" style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("subagents.builtinModelHint")}</span>}
      >
        {visibleBuiltins.map((agent) => (
          <SettingsRow
            key={agent.name}
            title={
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <Icon icon={Bot} size={13} />
                <span className="input-mono">{agent.name}</span>
                {badge(agent)}
              </span>
            }
            description={agent.description}
            action={
              <span className="input-mono" style={{ fontSize: 11, color: "var(--text-dim)" }} title={t("subagents.builtinModelHint")}>
                {agent.model || t("subagents.inheritModel")}
              </span>
            }
          />
        ))}
      </SettingsGroup>

      <div className="settings-row-desc" style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 12 }}>
        {t("subagents.hint")}
        <br />
        <span className="input-mono">{scope === "user" ? data?.paths.user : data?.paths.project ?? data?.paths.user}</span>
      </div>
    </>
  );

  const confirm = pendingDelete ? (
    <ConfirmDialog
      title={t("subagents.deleteConfirm", { name: pendingDelete.name })}
      body={t("subagents.deleteConfirmBody")}
      confirmLabel={t("subagents.delete")}
      destructive
      busy={busyName === pendingDelete.name}
      onConfirm={() => void removeAgent(pendingDelete)}
      onCancel={() => setPendingDelete(null)}
    />
  ) : null;

  return (
    <div className="settings-page-general">
      {body}
      {confirm}
    </div>
  );
}
