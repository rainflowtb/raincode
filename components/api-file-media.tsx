"use client";
/**
 * Elements that render `/api/…` media. The desktop client has no HTTP origin
 * for element srcs, so these bridge through useApiObjectUrl (blob: URLs).
 */
import { useState, type CSSProperties } from "react";
import { Download } from "lucide-react";
import { apiFetch } from "@/lib/api-transport";
import { useApiObjectUrl } from "@/hooks/useApiObjectUrl";
import { useLocale } from "@/hooks/useLocale";
import { Icon } from "./Icon";

/** <img> that resolves `/api/` srcs through a blob object URL. */
export function ApiImage({
  src,
  alt,
  style,
  className,
  onLoad,
}: {
  src: string | undefined;
  alt?: string;
  style?: CSSProperties;
  className?: string;
  onLoad?: (event: React.SyntheticEvent<HTMLImageElement>) => void;
}) {
  const { url } = useApiObjectUrl(src ?? null);
  if (!url) return null;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt={alt ?? ""} style={style} className={className} onLoad={onLoad} loading="lazy" />;
}

/** Download button for a `/api/files?type=download` URL (fetch → blob → save). */
export function FileDownloadButton({ apiUrl, fileName }: { apiUrl: string; fileName: string }) {
  const { t } = useLocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClick = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(apiUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      disabled={busy}
      title={error ?? t("viewer.download")}
      aria-label={t("viewer.download")}
      className="file-viewer-icon-button"
      style={error ? { color: "var(--destructive)" } : undefined}
    >
      <Icon icon={Download} size={14} strokeWidth={2.2} />
    </button>
  );
}
