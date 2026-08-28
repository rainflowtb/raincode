"use client";

/**
 * Provider-error strip for a finished-but-failed assistant message: expandable
 * error detail plus an optional "continue" retry action (server rewinds the
 * tree to before the failed turn and re-runs it — rpc-session-commands
 * "continue").
 */

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Icon } from "../Icon";
import { useLocale } from "@/hooks/useLocale";

export function AssistantErrorBlock({
  errorMessage,
  hasContent,
  onContinue,
}: {
  errorMessage: string;
  /** Whether the assistant message has visible blocks above the strip. */
  hasContent: boolean;
  onContinue?: () => void;
}) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  return (
    <div
      role="alert"
      style={{
        marginTop: hasContent ? 8 : 0,
        color: "var(--destructive)",
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        lineHeight: 1.5,
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          width: "100%",
          minHeight: 22,
          padding: 0,
          background: "none",
          border: "none",
          color: "inherit",
          cursor: "pointer",
          textAlign: "left",
          minWidth: 0,
          fontSize: "inherit",
          fontFamily: "inherit",
        }}
      >
        <Icon
          icon={ChevronRight}
          size={10}
          strokeWidth={1.6}
          style={{
            flexShrink: 0,
            opacity: 0.55,
            transform: open ? "rotate(90deg)" : "none",
            transition: "transform 0.15s ease",
          }}
        />
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
            minWidth: 0,
          }}
        >
          Error: {errorMessage}
        </span>
      </button>
      {open && (
        <div
          style={{
            marginTop: 4,
            marginLeft: 17,
            padding: "6px 8px",
            border: "1px solid var(--destructive-border)",
            borderRadius: "var(--radius-sm)",
            background: "var(--destructive-bg)",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          {errorMessage}
        </div>
      )}
      {onContinue && (
        <button
          type="button"
          className="btn-ghost btn-compact"
          onClick={onContinue}
          style={{ marginLeft: 17, marginTop: 6 }}
        >
          {t("chat.continueTurn")}
        </button>
      )}
    </div>
  );
}
