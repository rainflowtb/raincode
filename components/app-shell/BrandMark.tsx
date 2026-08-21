"use client";

/** Brand glyph + optional RainCode wordmark — glyph alone in the shell top bar,
    glyph + wordmark on the welcome screen. */
import Image from "next/image";

export function BrandGlyph({ size = 18 }: { size?: number }) {
  return (
    <Image
      src="/icon.png"
      alt=""
      width={size}
      height={size}
      style={{ display: "block", borderRadius: "var(--radius-xs)", flexShrink: 0 }}
    />
  );
}

export function BrandMark({ size = 18, fontSize = 14, showName = true }: { size?: number; fontSize?: number; showName?: boolean }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7, flexShrink: 0, userSelect: "none" }}>
      <BrandGlyph size={size} />
      {showName && (
        <span
          style={{
            fontFamily: "var(--font-brand)",
            fontSize,
            fontWeight: 600,
            letterSpacing: "-0.04em",
            color: "var(--text)",
            lineHeight: 1,
            whiteSpace: "nowrap",
          }}
        >
          RainCode
        </span>
      )}
    </span>
  );
}
