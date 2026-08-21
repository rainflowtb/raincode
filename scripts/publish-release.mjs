#!/usr/bin/env node
/**
 * Publish a RainCode release: build all platform/arch installers, create ONE
 * GitHub release on rainflowtb/raincode-desktop, and upload every asset.
 *
 * Single owner of the publish step — no parallel ad-hoc curl scripts.
 *
 * Usage:
 *   GH_TOKEN=ghp_xxx node scripts/publish-release.mjs [--dry-run] [--notes "changelog"] [--only <id>]
 *
 * Prereqs:
 *   - package.json version is already bumped (npm version patch)
 *   - GH_TOKEN env has a GitHub PAT with `repo` scope
 *
 * Flags:
 *   --dry-run   resolve asset paths + show what would be uploaded, skip API calls
 *   --notes STR release body (default: auto-generated per-asset manifest)
 *   --only ID   build/upload only one target, e.g. mac-arm64 / mac-x64 / win-x64 / win-arm64
 *
 * Each TARGET runs `npm run dist:<id>` which sets RAINCODE_TARGET so the bundled
 * Node runtime matches the installer's platform/arch.
 */
import { spawn } from "child_process";
import { existsSync, statSync, readFileSync } from "fs";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "rainflowtb/raincode-desktop";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const notesIdx = args.indexOf("--notes");
const notes = notesIdx >= 0 ? args[notesIdx + 1] : "";
const onlyIdx = args.indexOf("--only");
const onlyId = onlyIdx >= 0 ? args[onlyIdx + 1] : "";

function die(msg, code = 1) {
  console.error(`✗ ${msg}`);
  process.exit(code);
}

function run(cmd, cmdArgs, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, cmdArgs, { stdio: "inherit", cwd: root, ...opts });
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} ${cmdArgs.join(" ")} exited ${c}`))));
  });
}

function readVersion() {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return pkg.version;
}

// Build matrix: id → { script, file(version) }.
// file() must match package.json build.{mac,win}.artifactName = RainCode-${version}-${arch}.${ext}
// and electron-builder's arch suffix. mac → .dmg, win → .exe.
const TARGETS = [
  { id: "mac-arm64", script: "dist:mac-arm64", file: (v) => `RainCode-${v}-arm64.dmg`, label: "macOS Apple Silicon (M1/M2/M3/M4)" },
  { id: "mac-x64", script: "dist:mac-x64", file: (v) => `RainCode-${v}-x64.dmg`, label: "macOS Intel" },
  { id: "win-x64", script: "dist:win-x64", file: (v) => `RainCode-${v}-x64.exe`, label: "Windows x64 (Intel/AMD)" },
  { id: "win-arm64", script: "dist:win-arm64", file: (v) => `RainCode-${v}-arm64.exe`, label: "Windows ARM64" },
];

function selectedTargets() {
  if (!onlyId) return TARGETS;
  const t = TARGETS.find((x) => x.id === onlyId);
  if (!t) die(`Unknown --only target "${onlyId}". Valid: ${TARGETS.map((x) => x.id).join(", ")}`);
  return [t];
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

async function findReleaseByTag(tag) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`, {
    headers: { Authorization: `token ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) die(`GitHub API releases/tags/${tag} → ${res.status}`);
  return res.json();
}

async function uploadAsset(uploadUrl, file) {
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

function releaseBody(version, built) {
  const lines = [`RainCode ${version}.`, "", "## Downloads", ""];
  for (const t of built) {
    const f = t.file(version);
    const url = `https://github.com/${REPO}/releases/download/v${version}/${encodeURIComponent(f)}`;
    lines.push(`- **${t.label}** — \`${f}\``);
    lines.push(`  ${url}`);
  }
  lines.push("", "## Install", "", "**macOS**: open the .dmg, drag RainCode to Applications. On first launch, if macOS warns the developer cannot be verified: System Settings → Privacy & Security → Open Anyway.", "", "**Windows**: run the .exe installer.");
  return lines.join("\n");
}

async function main() {
  if (!process.env.GH_TOKEN) die("GH_TOKEN env is required (GitHub PAT with `repo` scope).");

  const version = readVersion();
  const tag = `v${version}`;
  const targets = selectedTargets();
  console.log(`▶ RainCode ${version}  (tag ${tag})  →  ${REPO}${dryRun ? "  [DRY RUN]" : ""}`);
  console.log(`  targets: ${targets.map((t) => t.id).join(", ")}`);

  // 1. Build each target (reuse existing artifact if present)
  const built = [];
  for (const t of targets) {
    const assetFile = join(root, "dist", t.file(version));
    if (existsSync(assetFile)) {
      const sizeMB = (statSync(assetFile).size / 1024 / 1024).toFixed(1);
      console.log(`\n● Reusing existing ${t.id}: ${t.file(version)} (${sizeMB} MB)`);
    } else {
      console.log(`\n● Building ${t.id} (npm run ${t.script}) — this takes several minutes…`);
      await run("npm", ["run", t.script]);
    }
    if (!existsSync(assetFile)) die(`build did not produce ${assetFile}`);
    const sizeMB = (statSync(assetFile).size / 1024 / 1024).toFixed(1);
    console.log(`  ✓ ${t.file(version)} ready (${sizeMB} MB)`);
    built.push({ ...t, path: assetFile });
  }

  if (dryRun) {
    console.log(`\n[DRY RUN] would create/patch release ${tag} on ${REPO} and upload ${built.length} asset(s):`);
    for (const b of built) console.log(`  - ${b.file(version)}`);
    return;
  }

  // 2. Find or create the release (idempotent: v1.1.3 may already exist from a partial run)
  let release = await findReleaseByTag(tag);
  if (release) {
    console.log(`\n● Release ${tag} already exists (${release.html_url}) — patching assets`);
  } else {
    console.log(`\n● Creating release ${tag} on ${REPO}…`);
    release = await ghApi(`/repos/${REPO}/releases`, {
      method: "POST",
      body: JSON.stringify({
        tag_name: tag,
        target_commitish: "main",
        name: `RainCode ${version}`,
        body: releaseBody(version, built),
        draft: false,
        prerelease: false,
      }),
    });
    console.log(`  ✓ release id ${release.id}: ${release.html_url}`);
  }

  // 3. Upload assets that aren't already attached
  const existingAssets = new Map((release.assets || []).map((a) => [a.name, a]));
  for (const b of built) {
    const name = b.file(version);
    if (existingAssets.has(name)) {
      console.log(`\n● ${name} already uploaded — skipping`);
      continue;
    }
    const sizeMB = (statSync(b.path).size / 1024 / 1024).toFixed(1);
    console.log(`\n● Uploading ${name} (${sizeMB} MB)…`);
    const asset = await uploadAsset(release.upload_url, b.path);
    console.log(`  ✓ ${asset.browser_download_url}`);
  }

  // 4. Refresh release body so the download manifest lists every asset
  await ghApi(`/repos/${REPO}/releases/${release.id}`, {
    method: "PATCH",
    body: JSON.stringify({ body: releaseBody(version, built) }),
  });

  console.log(`\n✓ Published: ${release.html_url}`);
}

main().catch((e) => die(e.message || String(e)));
