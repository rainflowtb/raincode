#!/usr/bin/env node
// Prepare RainCode brand assets from electron/icons/raincode-source.png
// (black rainflow glyph on white, no alpha). Outputs:
//   electron/icons/raincode-glyph.png  — trimmed, transparent background
//   electron/icons/raincode-1024.png   — trimmed glyph on white, 1024px
//   public/icon.png                    — 512px white square (in-app logo)
//   docs/icon.png                      — 512px white square (docs site)
// Run: node scripts/prepare-raincode-icon.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const iconsDir = path.join(root, "electron", "icons");
const SRC = path.join(iconsDir, "raincode-source.png");

// Colormap PNG → RGBA, then alpha = ink darkness so white becomes transparent.
const { data, info } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width, height } = info;
const px = new Uint8Array(data); // RGBA
let minX = width, minY = height, maxX = -1, maxY = -1;
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const ink = 255 - Math.min(px[i], px[i + 1], px[i + 2]);
    px[i] = 0;
    px[i + 1] = 0;
    px[i + 2] = 0;
    px[i + 3] = ink;
    if (ink > 24) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}
if (maxX < 0) throw new Error("no ink found in source image");
const trimW = maxX - minX + 1;
const trimH = maxY - minY + 1;

const glyph = await sharp(px, { raw: { width, height, channels: 4 } })
  .extract({ left: minX, top: minY, width: trimW, height: trimH })
  // Square canvas, 6% breathing room so circular crops don't clip the glyph
  .resize(1024, 1024, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toBuffer();
await sharp(glyph).toFile(path.join(iconsDir, "raincode-glyph.png"));

const white1024 = await sharp(glyph)
  .flatten({ background: "#ffffff" })
  .png()
  .toBuffer();
fs.writeFileSync(path.join(iconsDir, "raincode-1024.png"), white1024);

for (const target of ["public/icon.png", "docs/icon.png"]) {
  await sharp(white1024).resize(512, 512).png().toFile(path.join(root, target));
}

console.log(`glyph trimmed to ${trimW}x${trimH}; wrote raincode-glyph.png, raincode-1024.png, public/icon.png, docs/icon.png`);
