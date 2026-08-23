"use client";
/**
 * Resolve an `/api/…` URL to a revocable `blob:` object URL via apiFetch.
 *
 * In the desktop client there is no HTTP origin behind relative URLs — element
 * srcs (`<img>`, `<audio>`, `<iframe>`, `<a download>`) cannot use apiFetch,
 * and `app://` only serves the renderer bundle. Media previews therefore load
 * bytes in JS (through the IPC transport, keeping the route's allow-list) and
 * hand the element a blob: URL. Non-`/api/` URLs pass through unchanged.
 */
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-transport";

export type ApiObjectUrlState = {
  url: string | null;
  error: string | null;
  loading: boolean;
};

function isApiUrl(url: string): boolean {
  return url.startsWith("/api/");
}

export function useApiObjectUrl(sourceUrl: string | null): ApiObjectUrlState {
  const [fetched, setFetched] = useState<{
    key: string | null;
    url: string | null;
    error: string | null;
  }>({ key: null, url: null, error: null });

  useEffect(() => {
    if (!sourceUrl || !isApiUrl(sourceUrl)) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    void (async () => {
      try {
        const res = await apiFetch(sourceUrl);
        if (!res.ok) {
          let message = `HTTP ${res.status}`;
          try {
            const data = await res.json() as { error?: unknown };
            if (typeof data?.error === "string" && data.error) message = data.error;
          } catch {
            // non-JSON error body — keep the status line
          }
          throw new Error(message);
        }
        const blob = await res.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setFetched({ key: sourceUrl, url: objectUrl, error: null });
      } catch (error) {
        if (cancelled) return;
        setFetched({
          key: sourceUrl,
          url: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [sourceUrl]);

  if (!sourceUrl) return { url: null, error: null, loading: false };
  if (!isApiUrl(sourceUrl)) return { url: sourceUrl, error: null, loading: false };
  if (fetched.key !== sourceUrl) return { url: null, error: null, loading: true };
  return { url: fetched.url, error: fetched.error, loading: false };
}
