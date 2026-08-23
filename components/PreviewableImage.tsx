"use client";

import { useEffect, useId, useState, type CSSProperties, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { Icon } from "./Icon";
import { useApiObjectUrl } from "@/hooks/useApiObjectUrl";

interface PreviewableImageProps {
  src: string;
  alt?: string;
  className?: string;
  style?: CSSProperties;
  /** Accessible name for the lightbox dialog. */
  previewLabel?: string;
}

/**
 * Thumbnail that opens a true full-screen preview on click.
 * Shared by chat transcript images and markdown body images.
 */
export function PreviewableImage({
  src,
  alt = "",
  className,
  style,
  previewLabel,
}: PreviewableImageProps) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const titleId = useId();
  // `/api/…` srcs (local files referenced from markdown) need the blob bridge —
  // element srcs have no HTTP origin in the desktop client.
  const { url: resolvedSrc } = useApiObjectUrl(src || null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
    };

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey, true);

    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  if (!src || !resolvedSrc) return null;

  const openPreview = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setOpen(true);
  };

  const closePreview = () => setOpen(false);

  const label = previewLabel || alt || "Image preview";

  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={resolvedSrc}
        alt={alt}
        loading="lazy"
        className={["previewable-image", className].filter(Boolean).join(" ")}
        style={style}
        onClick={openPreview}
        role="button"
        tabIndex={0}
        aria-haspopup="dialog"
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      />
      {open && mounted && createPortal(
        <div
          className="image-preview-fullscreen"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          onClick={closePreview}
        >
          <span id={titleId} className="sr-only">{label}</span>
          <button
            type="button"
            className="image-preview-fullscreen-close"
            aria-label="Close"
            onClick={(event) => {
              event.stopPropagation();
              closePreview();
            }}
          >
            <Icon icon={X} size={18} strokeWidth={2} />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className="image-preview-fullscreen-img"
            src={resolvedSrc}
            alt={alt}
            onClick={(event) => event.stopPropagation()}
            draggable={false}
          />
        </div>,
        document.body,
      )}
    </>
  );
}
