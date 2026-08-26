"use client";

import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type Ref } from "react";

export type ComposerPaletteProps = {
  title?: ReactNode;
  hint?: ReactNode;
  /** CSS max-height for the whole card (default history-sized). */
  maxHeight?: string;
  menuRef?: Ref<HTMLDivElement>;
  bodyStyle?: CSSProperties;
  children: ReactNode;
};

/**
 * Floating autocomplete chrome above the chat composer (history / slash / @).
 */
export function ComposerPalette({
  title,
  hint,
  maxHeight = "min(44vh, 360px)",
  menuRef,
  bodyStyle,
  children,
}: ComposerPaletteProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [capPx, setCapPx] = useState<number | null>(null);

  // The card grows upward from the composer. When the composer sits high (the
  // empty-session centered layout), an unconstrained maxHeight pushes the top
  // past the nearest clipping ancestor (chat column / empty-state wrapper) and
  // the first rows get sliced off. Cap the height to the space actually
  // available above the anchor.
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const update = () => {
      const anchor = el.offsetParent as HTMLElement | null;
      if (!anchor) return;
      let boundaryTop = 0;
      for (let node = anchor.parentElement; node; node = node.parentElement) {
        if (getComputedStyle(node).overflowY !== "visible") {
          boundaryTop = node.getBoundingClientRect().top;
          break;
        }
      }
      const available = anchor.getBoundingClientRect().top - 8 - boundaryTop - 8;
      setCapPx(Math.max(120, Math.floor(available)));
    };
    update();
    window.addEventListener("resize", update);
    const ro = new ResizeObserver(update);
    if (el.offsetParent instanceof HTMLElement) ro.observe(el.offsetParent);
    return () => {
      window.removeEventListener("resize", update);
      ro.disconnect();
    };
  }, []);

  const effectiveMaxHeight = capPx != null ? `min(${maxHeight}, ${capPx}px)` : maxHeight;

  const setRefs = (node: HTMLDivElement | null) => {
    cardRef.current = node;
    if (typeof menuRef === "function") menuRef(node);
    else if (menuRef) menuRef.current = node;
  };

  return (
    <div
      ref={setRefs}
      className="menu-card"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: "calc(100% + 8px)",
        zIndex: 120,
        maxHeight: effectiveMaxHeight,
        overflow: "hidden",
        borderRadius: "var(--radius-md)",
        padding: 3,
      }}
    >
      {(title != null || hint != null) && (
      <div
        style={{
          padding: "8px 10px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          fontSize: 11,
          color: "var(--text-dim)",
        }}
      >
        <span>{title}</span>
        {hint != null && (
          <span style={{ fontFamily: "var(--font-mono)" }}>{hint}</span>
        )}
      </div>
      )}
      <div
        style={{
          maxHeight: title != null || hint != null ? `calc(${effectiveMaxHeight} - 34px)` : effectiveMaxHeight,
          overflowY: "auto",
          padding: 4,
          ...bodyStyle,
        }}
      >
        {children}
      </div>
    </div>
  );
}
