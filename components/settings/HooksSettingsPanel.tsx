/**
 * Settings → Hooks: user/project lifecycle hooks list, search, and editor.
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, RefreshCw, Search } from "lucide-react";
import { useLocale } from "@/hooks/useLocale";
import { apiFetch } from "@/lib/api-transport";
import type { HookListItem, HookScope } from "@/lib/hooks-schema";
import { Icon } from "../Icon";
import { ConfirmDialog } from "../ConfirmDialog";
import { SettingsToggle } from "../SettingsToggle";
import { SettingsGroup, SettingsPageHeading, SettingsRow, SegmentedOption } from "./settings-ui";
import {
  HookForm,
  draftFromHook,
  draftToPayload,
  emptyHookDraft,
  hookEventLabelKey,
  type HookDraft,
} from "./HookForm";

type HookFormState = { mode: "add" | "edit"; draft: HookDraft } | null;

export function HooksSettingsPanel({ cwd }: { cwd: string | null }) {
  const { t } = useLocale();
  const [scope, setScope] = useState<HookScope>("user");
  const [hooks, setHooks] = useState<HookListItem[]>([]);
  const [paths, setPaths] = useState<{ user?: string; project?: string }>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<HookFormState>(null);
  const [pendingDelete, setPendingDelete] = useState<HookListItem | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
      const res = await apiFetch(`/api/hooks${qs}`);
      const data = await res.json() as {
        hooks?: HookListItem[];
        paths?: { user?: string; project?: string };
        error?: string;
      };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setHooks(data.hooks ?? []);
      setPaths(data.paths ?? {});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    void load();
  }, [load]);

  const scopeHooks = useMemo(
    () => hooks.filter((hook) => hook.scope === scope),
    [hooks, scope],
  );

  const visibleHooks = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return scopeHooks;
    return scopeHooks.filter((hook) =>
      hook.name.toLowerCase().includes(query)
      || hook.command.toLowerCase().includes(query)
      || (hook.matcher ?? "").toLowerCase().includes(query),
    );
  }, [scopeHooks, search]);

  const toggle = async (hook: HookListItem) => {
    setBusyId(hook.id);
    setError(null);
    try {
      const res = await apiFetch("/api/hooks", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: hook.id, enabled: hook.enabled === false, scope: hook.scope, cwd: cwd ?? undefined }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const saveHook = async (draft: HookDraft) => {
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch("/api/hooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draftToPayload(draft, scope, cwd)),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setForm(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const removeHook = async (hook: HookListItem) => {
    setBusyId(hook.id);
    setError(null);
    try {
      const res = await apiFetch("/api/hooks", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: hook.id, scope: hook.scope, cwd: cwd ?? undefined }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setPendingDelete(null);
      setForm(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const openAdd = () => {
    setForm({ mode: "add", draft: emptyHookDraft() });
    setError(null);
  };

  const openEdit = (hook: HookListItem) => {
    setForm({ mode: "edit", draft: draftFromHook(hook) });
    setError(null);
  };

  const body = form ? (
    <HookForm
      mode={form.mode}
      initial={form.draft}
      saving={saving}
      error={error}
      onBack={() => {
        setForm(null);
        setError(null);
      }}
      onSave={(draft) => void saveHook(draft)}
      onDelete={form.mode === "edit"
        ? () => {
            const hook = scopeHooks.find((h) => h.id === form.draft.id);
            if (hook) setPendingDelete(hook);
          }
        : undefined}
    />
  ) : (
    <>
      <SettingsPageHeading
        title={t("hooks.title")}
        description={t("hooks.description")}
      />

      <div
        role="toolbar"
        aria-label={t("hooks.title")}
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 8,
          marginBottom: 12,
        }}
      >
        <div className="settings-segmented">
          <SegmentedOption active={scope === "user"} label={t("hooks.scopeUser")} onClick={() => setScope("user")} />
          <SegmentedOption
            active={scope === "project"}
            label={t("hooks.scopeProject")}
            title={cwd ? undefined : t("hooks.projectNeedCwd")}
            onClick={() => setScope("project")}
          />
        </div>
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {t("hooks.installed")} <span style={{ color: "var(--text)" }}>{scopeHooks.length}</span>
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
            placeholder={t("hooks.search")}
            aria-label={t("hooks.search")}
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
          {t("hooks.new")}
        </button>
      </div>

      {error && (
        <div className="settings-card-empty" role="alert" style={{ color: "var(--destructive)", marginBottom: 12 }}>
          {error}
        </div>
      )}

      {scope === "project" && !cwd ? (
        <div className="settings-card-empty">{t("hooks.projectNeedCwd")}</div>
      ) : (
        <SettingsGroup>
          {loading ? (
            <div className="settings-card-empty">{t("common.loading")}</div>
          ) : visibleHooks.length === 0 ? (
            search.trim() ? (
              <div className="settings-card-empty">{t("hooks.noMatches")}</div>
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
                <div style={{ fontSize: 13, fontWeight: 600 }}>{t("hooks.emptyTitle")}</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("hooks.emptyDesc")}</div>
                <button
                  type="button"
                  className="btn-primary btn-compact"
                  style={{ marginTop: 8 }}
                  onClick={openAdd}
                >
                  <Icon icon={Plus} size={12} strokeWidth={2} />
                  {t("hooks.newHook")}
                </button>
              </div>
            )
          ) : (
            visibleHooks.map((hook) => {
              const disabled = hook.enabled === false;
              const matcherSuffix = hook.matcher ? ` · ${hook.matcher}` : "";
              return (
                <SettingsRow
                  key={`${hook.scope}:${hook.id}`}
                  title={
                    <span style={disabled ? { color: "var(--text-dim)" } : undefined}>{hook.name}</span>
                  }
                  description={
                    <>
                      {t(hookEventLabelKey(hook.event))}{matcherSuffix}
                      {" · "}
                      <span className="input-mono" style={{ fontSize: 11 }}>{hook.command}</span>
                    </>
                  }
                  onClick={() => openEdit(hook)}
                  action={
                    <SettingsToggle
                      enabled={!disabled}
                      loading={busyId === hook.id}
                      onChange={() => void toggle(hook)}
                    />
                  }
                />
              );
            })
          )}
        </SettingsGroup>
      )}

      <div className="settings-row-desc" style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 12 }}>
        {t("hooks.hint")}
        {(scope === "user" ? paths.user : paths.project) && (
          <>
            <br />
            <span className="input-mono">{scope === "user" ? paths.user : paths.project}</span>
          </>
        )}
      </div>
    </>
  );

  const confirm = pendingDelete ? (
    <ConfirmDialog
      title={t("hooks.deleteConfirm", { name: pendingDelete.name })}
      body={t("hooks.deleteConfirmBody")}
      confirmLabel={t("hooks.delete")}
      destructive
      busy={busyId === pendingDelete.id}
      onConfirm={() => void removeHook(pendingDelete)}
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
