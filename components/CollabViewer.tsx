"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { parseCollabChat, type CollabChatMessage } from "@/lib/collab-messages";
import { Icon } from "./Icon";
import { MarkdownBody } from "./MarkdownBody";
import { useLocale } from "@/hooks/useLocale";
import { useIsMobile } from "@/hooks/useIsMobile";
import { apiFetch, apiStream, type ApiStream } from "@/lib/api-transport";

export function CollabViewer({ token }: { token: string }) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const [status, setStatus] = useState<"connecting" | "live" | "error">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<{
    sessionId?: string;
    note?: string;
    createdAt?: string;
  } | null>(null);
  const [rawLines, setRawLines] = useState<string[]>([]);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [stickBottom, setStickBottom] = useState(true);
  const [unread, setUnread] = useState(0);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const stickBottomRef = useRef(true);
  const lastMsgCountRef = useRef(0);
  stickBottomRef.current = stickBottom;

  useEffect(() => {
    let cancelled = false;
    let es: ApiStream | null = null;

    const loadMeta = async () => {
      try {
        const res = await apiFetch(`/api/collab/${encodeURIComponent(token)}`);
        const data = await res.json() as {
          error?: string;
          share?: { sessionId?: string; note?: string; createdAt?: string };
          snapshot?: {
            preview?: string;
            lines?: string[];
            size?: number;
            mtimeMs?: number;
            exists?: boolean;
            truncated?: boolean;
          };
        };
        if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
        if (cancelled) return;
        setMeta({
          sessionId: data.share?.sessionId,
          note: data.share?.note,
          createdAt: data.share?.createdAt,
        });
        if (Array.isArray(data.snapshot?.lines) && data.snapshot.lines.length > 0) {
          setRawLines(data.snapshot.lines.filter((l) => l.length > 0));
        } else if (data.snapshot?.preview) {
          setRawLines(data.snapshot.preview.split("\n").filter((l) => l.length > 0));
        }
        if (typeof data.snapshot?.mtimeMs === "number") setUpdatedAt(data.snapshot.mtimeMs);
        setTruncated(Boolean(data.snapshot?.truncated));
      } catch (e) {
        if (!cancelled) {
          setStatus("error");
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    };

    void loadMeta();

    es = apiStream(`/api/collab/${encodeURIComponent(token)}/events`);
    es.addEventListener("ready", () => {
      if (!cancelled) setStatus("live");
    });
    es.addEventListener("update", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as {
          size?: number;
          mtimeMs?: number;
          lines?: string[];
        };
        if (cancelled) return;
        if (Array.isArray(data.lines)) {
          setRawLines(data.lines.filter((l) => typeof l === "string" && l.length > 0));
        }
        if (typeof data.mtimeMs === "number") setUpdatedAt(data.mtimeMs);
        if (typeof (data as { truncated?: boolean }).truncated === "boolean") {
          setTruncated(Boolean((data as { truncated?: boolean }).truncated));
        }
        setStatus("live");
      } catch {
        // ignore
      }
    });
    es.onerror = () => {
      if (!cancelled) setStatus((s) => (s === "error" ? s : "connecting"));
    };

    return () => {
      cancelled = true;
      es?.close();
    };
  }, [token]);

  const messages: CollabChatMessage[] = useMemo(
    () => parseCollabChat(rawLines, 500),
    [rawLines],
  );

  useEffect(() => {
    const count = messages.length;
    const prev = lastMsgCountRef.current;
    if (count > prev) {
      const delta = count - prev;
      if (stickBottomRef.current) {
        setUnread(0);
      } else if (prev > 0) {
        // Only count as unread after initial load.
        setUnread((u) => u + delta);
      }
    }
    lastMsgCountRef.current = count;
  }, [messages]);

  useEffect(() => {
    if (!stickBottom) return;
    setUnread(0);
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, stickBottom]);

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = dist < 80;
    setStickBottom(atBottom);
    if (atBottom) setUnread(0);
  };

  const jumpToLatest = () => {
    setUnread(0);
    setStickBottom(true);
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  };

  return (
    <div
      style={{
        height: "100dvh",
        background: "var(--canvas)",
        color: "var(--text)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <header
        style={{
          padding: isMobile ? "6px 12px" : "0 12px",
          minHeight: "var(--titlebar-height, 40px)",
          display: "flex",
          flexWrap: "wrap",
          rowGap: 4,
          columnGap: isMobile ? 8 : 12,
          alignItems: "center",
        }}
      >
        <div style={{ fontWeight: 600, fontSize: 13 }}>{t("collab.title")}</div>
        {/* Status: quiet dot + label, not a pill */}
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 11,
            color: status === "live" ? "var(--success)" : status === "error" ? "var(--destructive)" : "var(--text-muted)",
          }}
        >
          <span
            aria-hidden
            style={{
              width: 7,
              height: 7,
              borderRadius: "var(--radius-pill)",
              background: "currentColor",
              flexShrink: 0,
            }}
          />
          {status === "live" ? t("collab.live") : status === "error" ? t("collab.connError") : t("collab.connecting")}
        </span>
        <span
          style={{
            fontSize: 11,
            padding: "2px 8px",
            borderRadius: "var(--radius-pill)",
            background: "var(--bg-subtle)",
            border: "1px solid var(--border)",
            color: "var(--text-muted)",
          }}
        >
          {t("collab.readOnly")}
        </span>
        {/* Mobile: break to a second line for the counters so row 1 stays calm */}
        {isMobile && <div style={{ flexBasis: "100%", height: 0 }} aria-hidden />}
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
          {t("collab.messageCount", { n: messages.length })}{truncated ? ` · ${t("collab.truncated")}` : ""}
        </span>
        {updatedAt != null && !isMobile && (
          <span style={{ fontSize: 11, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>
            {new Date(updatedAt).toLocaleTimeString()}
          </span>
        )}
        {unread > 0 && (
          <button
            type="button"
            onClick={jumpToLatest}
            title={t("collab.jumpToLatest")}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              border: "1px solid var(--border)",
              background: "var(--bg-subtle)",
              color: "var(--text)",
              borderRadius: "var(--radius-pill)",
              padding: "2px 8px 2px 10px",
              fontSize: 11,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            {t("collab.newMessages")}
            <span
              style={{
                minWidth: 18,
                height: 18,
                padding: "0 5px",
                borderRadius: "var(--radius-pill)",
                background: "var(--accent)",
                color: "var(--accent-fg)",
                fontSize: 11,
                fontWeight: 600,
                fontVariantNumeric: "tabular-nums",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {unread > 99 ? "99+" : unread}
            </span>
          </button>
        )}
        {!isMobile && (
          <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-dim)" }}>
            {t("collab.viewerHint")}
          </span>
        )}
      </header>

      {/* Content floats as a rounded panel on the canvas, same as the main chat */}
      <div style={{ flex: 1, minHeight: 0, padding: "0 8px 8px", display: "flex", flexDirection: "column" }}>
        <div className="shell-panel" style={{ flex: 1, minHeight: 0, position: "relative", display: "flex", flexDirection: "column" }}>
          {meta?.note && (
            <div style={{ padding: "8px 16px", fontSize: 12, color: "var(--text-muted)", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
              {meta.note}
            </div>
          )}

          {error ? (
            <div style={{ padding: 24, color: "var(--destructive)" }}>{error}</div>
          ) : (
            <>
              <main
                ref={scrollerRef}
                onScroll={onScroll}
                style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "16px 16px 40px" }}
              >
                <div style={{ maxWidth: 760, margin: "0 auto", display: "flex", flexDirection: "column", gap: 12 }}>
                  {messages.length === 0 ? (
                    <div style={{ color: "var(--text-dim)", fontSize: 13, textAlign: "center", padding: 40 }}>
                      {t("collab.waiting")}
                    </div>
                  ) : (
                    messages.map((m) => <ChatBubble key={m.id} message={m} />)
                  )}
                  <div ref={bottomRef} />
                </div>
              </main>

              {!stickBottom && messages.length > 0 && (
                <button
                  type="button"
                  className="btn-primary btn-compact"
                  onClick={jumpToLatest}
                  style={{
                    position: "absolute",
                    left: "50%",
                    transform: "translateX(-50%)",
                    bottom: 20,
                    zIndex: 5,
                    boxShadow: "var(--shadow-md)",
                    gap: 8,
                  }}
                >
                  <Icon icon={ArrowDown} size={12} strokeWidth={2} />
                  {t("collab.jumpToLatest")}
                  {unread > 0 && (
                    <span
                      style={{
                        minWidth: 18,
                        height: 18,
                        padding: "0 5px",
                        borderRadius: "var(--radius-pill)",
                        background: "var(--accent-fg)",
                        color: "var(--accent)",
                        fontSize: 11,
                        fontWeight: 600,
                        fontVariantNumeric: "tabular-nums",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      {unread > 99 ? "99+" : unread}
                    </span>
                  )}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ChatBubble({ message }: { message: CollabChatMessage }) {
  const { t } = useLocale();
  if (message.role === "meta") {
    return (
      <div style={{ textAlign: "center", fontSize: 11, color: "var(--text-dim)", padding: "4px 0" }}>
        {message.blocks.map((b, i) => (b.kind === "text" ? <span key={i}>{b.text}</span> : null))}
      </div>
    );
  }

  const isUser = message.role === "user";
  const isTool = message.role === "toolResult";
  const align = isUser ? "flex-end" : "flex-start";
  const bg = isUser
    ? "var(--user-bg)"
    : isTool
      ? "var(--tool-bg)"
      : "var(--assistant-bg)";
  const label =
    message.role === "user" ? t("collab.roleYou")
      : message.role === "assistant" ? t("collab.roleAssistant")
        : message.role === "toolResult" ? t("collab.roleTool")
          : message.role;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: align, gap: 4 }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "var(--text-dim)",
          padding: "0 4px",
        }}
      >
        {label}
      </div>
      <div
        style={{
          maxWidth: "min(100%, 640px)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          background: bg,
          padding: "10px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {message.blocks.map((b, i) => {
          if (b.kind === "text") {
            // Assistant text is markdown — render it; user text stays plain.
            if (!isUser) {
              return <MarkdownBody key={i}>{b.text}</MarkdownBody>;
            }
            return (
              <div key={i} style={{ fontSize: 14, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {b.text}
              </div>
            );
          }
          if (b.kind === "thinking") {
            return (
              <div
                key={i}
                style={{
                  fontSize: 12,
                  color: "var(--text-muted)",
                  borderLeft: "2px solid var(--border)",
                  paddingLeft: 8,
                  whiteSpace: "pre-wrap",
                }}
              >
                {b.text}
              </div>
            );
          }
          if (b.kind === "tool") {
            return (
              <div
                key={i}
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-sm)",
                  padding: "6px 8px",
                  background: "var(--bg-subtle)",
                }}
              >
                <span style={{ fontWeight: 600, color: "var(--accent)" }}>{b.name}</span>
                {b.inputPreview && (
                  <div style={{ color: "var(--text-dim)", marginTop: 4, wordBreak: "break-all" }}>{b.inputPreview}</div>
                )}
              </div>
            );
          }
          // toolResult
          return (
            <div
              key={i}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                border: `1px solid ${b.isError ? "var(--destructive-border)" : "var(--border)"}`,
                borderRadius: "var(--radius-sm)",
                padding: "6px 8px",
                background: b.isError ? "var(--destructive-bg)" : "var(--bg-subtle)",
                color: b.isError ? "var(--destructive)" : "var(--text-muted)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {b.name && <div style={{ fontWeight: 600, marginBottom: 4 }}>{b.name}</div>}
              {b.text}
            </div>
          );
        })}
      </div>
    </div>
  );
}
