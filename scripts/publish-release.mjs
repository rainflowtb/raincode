#!/usr/bin/env node
/**
 * Publish a RainCode release: build the macOS DMG, then create a GitHub
 * release on rainflowtb/raincode-desktop and upload the DMG as an asset.
 *
 * Single owner of the publish step — no parallel ad-hoc curl scripts.
 *
 * Usage:
 *   GH_TOKEN=ghp_xxx node scripts/publish-release.mjs [--dry-run] [--notes "changelog"]
 *
 * Prereqs:
 *   - package.json version is already bumped (npm version patch)
 *   - GH_TOKEN env has a GitHub PAT with `repo` scope
 *
 * --dry-run: build + resolve asset path + show what would be uploaded, skip API calls.
 */
import { spawn } from "child_process";
import { existsSync, statSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "rainflowtb/raincode-desktop";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const notesIdx = args.indexOf("--notes");
const notes = notesIdx >= 0 ? args[notesIdx + 1] : "";

function die(msg, code = 1) {
  console.error(`✗ ${msg}`);
  process.exit(code);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit", cwd: root, ...opts });
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} exited ${c}`))));
  });
}

function readVersion() {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return pkg.version;
}

function assetPath(version) {
  // matches build.dmg.artifactName = RainCode-${version}-${arch}.${ext}
  return join(root, "dist", `RainCode-${version}-arm64.dmg`);
}

async function ghApi(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `token ${process.env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      ...(init.body && typeof init.body === "string"
        ? { "Content-Type": "application/json" }
        : {}),
      ...init.headers,
    },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) die(`GitHub API ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return data;
}

async function uploadAsset(uploadUrl, file) {
  // uploadUrl already has the {?name,label} suffix; append our name
  const url = uploadUrl.replace("{?name,label}", `?name=${encodeURIComponent(basename(file))}`);
  const buf = readFileSync(file);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `token ${process.env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/octet-stream",
      "Content-Length": buf.length,
    },
    body: buf,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) die(`asset upload → ${res.status}: ${text.slice(0, 300)}`);
  return data;
}

function basename(p) {
  return p.split("/").pop();
}

async function main() {
  if (!process.env.GH_TOKEN) die("GH_TOKEN env is required (GitHub PAT with `repo` scope).");

  const version = readVersion();
  const tag = `v${version}`;
  const dmg = assetPath(version);
  console.log(`▶ RainCode ${version}  (tag ${tag})  →  ${REPO}${dryRun ? "  [DRY RUN]" : ""}`);

  // 1. Build the DMG (idempotent: reuse if already built & version matches)
  const needBuild = !existsSync(dmg);
  if (needBuild) {
    console.log("\n● Building DMG (npm run dist:dmg) — this takes several minutes…");
    await run("npm", ["run", "dist:dmg"]);
  } else {
    console.log(`\n● Reusing existing ${dmg}`);
  }
  if (!existsSync(dmg)) die(`build did not produce ${dmg}`);
  const sizeMB = (statSync(dmg).size / 1024 / 1024).toFixed(1);
  console.log(`  ✓ DMG ready: ${dmg} (${sizeMB} MB)`);

  if (dryRun) {
    console.log(`\n[DRY RUN] would create release ${tag} on ${REPO} and upload ${basename(dmg)}`);
    return;
  }

  // 2. Create the release — GitHub auto-creates the tag on desktop repo's main.
  console.log(`\n● Creating release ${tag} on ${REPO}…`);
  const body = notes || `RainCode ${version} (macOS Apple Silicon).\n\n## Download\n- \`RainCode-${version}-arm64.dmg\` (Apple Silicon M1/M2/M3/M4)\n\n## Install\n1. Open the .dmg\n2. Drag RainCode into Applications\n3. On first launch, if macOS warns the developer cannot be verified: System Settings → Privacy & Security → Open Anyway`;
  const release = await ghApi(`/repos/${REPO}/releases`, {
    method: "POST",
    body: JSON.stringify({
      tag_name: tag,
      target_commitish: "main",
      name: `RainCode ${version} (macOS Apple Silicon)`,
      body,
      draft: false,
      prerelease: false,
    }),
  });
  console.log(`  ✓ release id ${release.id}: ${release.html_url}`);

  // 4. Upload the DMG asset
  console.log(`\n● Uploading ${basename(dmg)} (${sizeMB} MB)…`);
  const asset = await uploadAsset(release.upload_url, dmg);
  console.log(`  ✓ ${asset.browser_download_url}`);

  console.log(`\n✓ Published: ${release.html_url}`);
}

main().catch((e) => die(e.message || String(e)));
