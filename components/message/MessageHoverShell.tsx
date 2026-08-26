"use client";

import { useState, type CSSProperties, type ReactNode } from "react";

/**
 * Wrapper that owns the hover/focus state used to reveal a message's action row.
 * The message body is passed as `children`, so its element identity stays stable
 * across hover updates and React bails out of re-rendering that subtree — a
 * mouseenter no longer rebuilds thousands of diff rows below.
 */
export function MessageHoverShell({ style, renderActions, children }: {
  style: CSSProperties;
  renderActions: (active: boolean) => ReactNode;
  children: ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  // Touch devices have no hover: keep the action row always visible so the
  // first tap acts instead of only revealing (lazy init — runs in browser).
  const [coarsePointer] = useState(
    () => typeof window !== "undefined" && typeof window.matchMedia === "function"
      && window.matchMedia("(hover: none)").matches,
  );
  const active = hovered || coarsePointer;

  return (
    <div
      style={style}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={(e) => {
        // React onBlur is focusout: ignore focus moves between our own children.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setHovered(false);
      }}
    >
      {children}
      {renderActions(active)}
    </div>
  );
}

