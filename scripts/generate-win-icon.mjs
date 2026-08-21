#!/usr/bin/env node
// Generate electron/icons/icon.ico and app/favicon.ico from PNG masters.
// ICO = header + PNG payload entries (no external deps).
// Run: node scripts/generate-win-icon.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const iconsDir = path.join(root, "electron", "icons");

async function writeIco(masterPng, sizes, outFile) {
  const entries = [];
  for (const size of sizes) {
    const png = await sharp(masterPng).resize(size, size).png().toBuffer();
    entries.push({ size, png });
  }
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  const dirSize = 16 * entries.length;
  let offset = 6 + dirSize;
  const dir = Buffer.alloc(dirSize);
  entries.forEach(({ size, png }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o); // width (0 = 256)
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1); // height
    dir.writeUInt8(0, o + 2); // palette
    dir.writeUInt8(0, o + 3); // reserved
    dir.writeUInt16LE(1, o + 4); // color planes
    dir.writeUInt16LE(32, o + 6); // bpp
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  fs.writeFileSync(outFile, Buffer.concat([header, dir, ...entries.map((e) => e.png)]));
  console.log(`wrote ${path.relative(root, outFile)} (${sizes.join("/")} px)`);
}

await writeIco(path.join(iconsDir, "icon-1024.png"), [256, 48, 32, 16], path.join(iconsDir, "icon.ico"));
await writeIco(path.join(iconsDir, "icon-1024.png"), [32, 16], path.join(root, "app", "favicon.ico"));
