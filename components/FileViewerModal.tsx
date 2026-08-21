"use client";

/** Modal file viewer: explorer clicks open files in a floating dialog instead
    of a dedicated workspace tab. */
import { useEffect } from "react";
import { X } from "lucide-react";
import { useLocale } from "@/hooks/useLocale";
import { Icon } from "./Icon";
import { FileViewer } from "./app-shell/lazy-panels";

export type ViewerFileTarget = {
  filePath: string;
  sourceSessionId?: string | null;
  focusLine?: number | null;
};

export function FileViewerModal({
  file,
  cwd,
  gitRefreshKey,
  onClose,
  onOpenFile,
  onMentionLines,
  onMentionFile,
}: {
  file: ViewerFileTarget;
  cwd?: string;
  gitRefreshKey?: number;
  onClose: () => void;
  onOpenFile?: (filePath: string) => void;
  onMentionLines?: (filePath: string, startLine: number, endLine: number) => void;
  onMentionFile?: (relativePath: string) => void;
}) {
  const { t } = useLocale();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const fileName = file.filePath.split("/").pop() ?? file.filePath;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-shell"
        role="dialog"
        aria-label={fileName}
        style={{
          width: "min(960px, calc(100vw - 64px))",
          height: "min(720px, calc(100dvh - 96px))",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div className="modal-header-meta">
            <span className="modal-title">{fileName}</span>
            <span className="modal-subtitle" title={file.filePath}>
              {file.filePath}
            </span>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            title={t("common.close")}
            aria-label={t("common.close")}
          >
            <Icon icon={X} size={14} strokeWidth={1.75} />
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <FileViewer
            filePath={file.filePath}
            cwd={cwd}
            sourceSessionId={file.sourceSessionId}
            focusLine={file.focusLine}
            gitRefreshKey={gitRefreshKey}
            onOpenFile={onOpenFile}
            onMentionLines={onMentionLines}
            onMentionFile={onMentionFile}
          />
        </div>
      </div>
    </div>
  );
}
