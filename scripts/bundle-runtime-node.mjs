#!/usr/bin/env node
/**
 * Bundle a portable Node.js runtime into the Electron standalone tree so the
 * packaged app does NOT require users to install Node separately.
 *
 * Output:
 *   .next/standalone/bin/node(.exe)
 *   .next/standalone/bin/libnode*.dylib | .so | .dll  (when needed)
 *
 * Strategy:
 *   1. Prefer an official Node.js dist matching process.versions.node (cached under
 *      ~/.cache/raincode-node or $RAINCODE_NODE_CACHE).
 *   2. Fallback: copy a real Node binary + its linked libnode from Homebrew/system.
 */
import {
  chmodSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { pipeline } from "stream/promises";
import { spawnSync } from "child_process";

const root = process.cwd();
const standalone = join(root, ".next", "standalone");

// Target platform/arch for the bundled node binary. Defaults to the host so
// existing macOS builds keep working unchanged. Set RAINCODE_TARGET to cross-
// build, e.g. `win-x64`, `win-arm64`, `darwin-x64`, `darwin-arm64`.
const target = (process.env.RAINCODE_TARGET || `${process.platform}-${process.arch}`).toLowerCase();
const m = target.match(/^(darwin|win32|linux)-(arm64|x64|armv7l)$/);
if (!m) {
  console.error(`Invalid RAINCODE_TARGET="${target}" — expected <darwin|win32|linux>-<arm64|x64|armv7l>`);
  process.exit(1);
}
const targetPlatform = m[1];
const arch = m[2];
const isWin = targetPlatform === "win32";
const isMac = targetPlatform === "darwin";
const crossBuild = targetPlatform !== process.platform;  // target ≠ host
const outDir = join(standalone, "bin");
const outNode = join(outDir, isWin ? "node.exe" : "node");
const nodeVersion = process.versions.node;

// The desktop runtime is daemon/ipc-host.mjs; prepare-electron-standalone.mjs
// prunes the Next entry unless PI_WEB_KEEP_NEXT=1. Accept either shape.
if (!existsSync(join(standalone, "daemon", "ipc-host.mjs")) && !existsSync(join(standalone, "server.js"))) {
  console.error("Missing prepared standalone tree — run scripts/prepare-electron-standalone.mjs first.");
  process.exit(1);
}

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

function isElectronBinary(p) {
  return /electron/i.test(p) || /Electron\.app/i.test(p);
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", ...opts });
}

function platformTriple() {
  if (isWin) return `win-${arch}`;
  if (isMac) return `darwin-${arch}`;
  return `linux-${arch}`;
}

function cacheDir() {
  return (
    process.env.RAINCODE_NODE_CACHE ||
    join(homedir(), ".cache", "raincode-node")
  );
}

async function download(url, dest) {
  ensureDir(dirname(dest));
  if (existsSync(dest) && statSync(dest).size > 1_000_000) {
    console.log(`Using cached ${dest}`);
    return dest;
  }
  console.log(`Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }
  const tmp = `${dest}.partial`;
  await pipeline(res.body, createWriteStream(tmp));
  cpSync(tmp, dest);
  rmSync(tmp, { force: true });
  return dest;
}

async function installOfficialNodeDist() {
  const triple = platformTriple();
  const base = `node-v${nodeVersion}-${triple}`;
  const ext = isWin ? "zip" : "tar.gz";
  const url = `https://nodejs.org/dist/v${nodeVersion}/${base}.${ext}`;
  const cache = cacheDir();
  ensureDir(cache);
  const archive = join(cache, `${base}.${ext}`);
  await download(url, archive);

  const extractRoot = join(cache, base);
  if (!existsSync(join(extractRoot, isWin ? "node.exe" : "bin/node"))) {
    rmSync(extractRoot, { recursive: true, force: true });
    ensureDir(extractRoot);
    if (isWin) {
      // Windows target: unzip. On a Windows host use PowerShell Expand-Archive;
      // on macOS/Linux hosts fall back to the system `unzip` (shipped with macOS).
      if (process.platform === "win32") {
        const unzip = run("powershell", [
          "-NoProfile",
          "-Command",
          `Expand-Archive -Path '${archive.replace(/'/g, "''")}' -DestinationPath '${cache.replace(/'/g, "''")}' -Force`,
        ]);
        if (unzip.status !== 0) {
          throw new Error(unzip.stderr || "Failed to unzip Node dist");
        }
      } else {
        const unzip = run("unzip", ["-q", "-o", archive, "-d", cache]);
        if (unzip.status !== 0) {
          throw new Error(unzip.stderr || unzip.stdout || "Failed to unzip Node dist (install unzip?)");
        }
      }
    } else {
      // macOS/Linux target: tar.gz — system tar is always available.
      const tar = run("tar", ["-xzf", archive, "-C", cache]);
      if (tar.status !== 0) {
        throw new Error(tar.stderr || "Failed to extract Node dist");
      }
    }
  }

  const binSrc = isWin
    ? join(extractRoot, "node.exe")
    : join(extractRoot, "bin", "node");
  if (!existsSync(binSrc)) {
    throw new Error(`Extracted Node binary missing at ${binSrc}`);
  }

  ensureDir(outDir);
  // Clean previous runtime bits (keep pi shims if already written)
  for (const name of readdirSync(outDir)) {
    if (
      name === "node" ||
      name === "node.exe" ||
      name === "npm" ||
      name === "npm.cmd" ||
      name === "npx" ||
      name === "npx.cmd" ||
      name === "corepack" ||
      name.startsWith("libnode") ||
      name === "node-version.txt" ||
      name === "node_modules"
    ) {
      rmSync(join(outDir, name), { force: true, recursive: true });
    }
  }
  cpSync(binSrc, outNode);
  if (!isWin) chmodSync(outNode, 0o755);

  // Ship npm package + portable shims (official bin/npm is often a symlink into
  // the extract tree — resolve and rewrite so the packaged app stays relocatable).
  const npmLib = isWin
    ? join(extractRoot, "node_modules", "npm")
    : join(extractRoot, "lib", "node_modules", "npm");
  if (existsSync(npmLib)) {
    const destNpmLib = join(standalone, "lib", "node_modules", "npm");
    rmSync(destNpmLib, { recursive: true, force: true });
    mkdirSync(join(standalone, "lib", "node_modules"), { recursive: true });
    cpSync(npmLib, destNpmLib, { recursive: true });
    console.log("Bundled npm package under standalone/lib/node_modules/npm");

    if (!isWin) {
      const npmShim = `#!/bin/sh
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$DIR/node" "$DIR/../lib/node_modules/npm/bin/npm-cli.js" "$@"
`;
      const npxShim = `#!/bin/sh
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$DIR/node" "$DIR/../lib/node_modules/npm/bin/npx-cli.js" "$@"
`;
      writeFileSync(join(outDir, "npm"), npmShim, { mode: 0o755 });
      writeFileSync(join(outDir, "npx"), npxShim, { mode: 0o755 });
      try { chmodSync(join(outDir, "npm"), 0o755); } catch { /* ignore */ }
      try { chmodSync(join(outDir, "npx"), 0o755); } catch { /* ignore */ }
    } else {
      writeFileSync(
        join(outDir, "npm.cmd"),
        `@echo off
"%~dp0node.exe" "%~dp0..\lib\node_modules\npm\bin\npm-cli.js" %*
`,
      );
      writeFileSync(
        join(outDir, "npx.cmd"),
        `@echo off
"%~dp0node.exe" "%~dp0..\lib\node_modules\npm\bin\npx-cli.js" %*
`,
      );
    }
    console.log("Bundled portable npm/npx shims");
  }

  return { version: nodeVersion, source: url };
}

function resolveSystemNode() {
  const candidates = [
    process.env.PI_WEB_BUNDLE_NODE_BINARY,
    process.env.npm_node_execpath,
    process.execPath,
  ].filter(Boolean);

  try {
    const cmd = isWin ? "where" : "which";
    const res = run(cmd, ["node"]);
    if (res.status === 0) {
      const first = res.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (first) candidates.push(first);
    }
  } catch {
    // ignore
  }

  if (!isWin) {
    candidates.push("/opt/homebrew/bin/node", "/usr/local/bin/node");
  }

  for (const c of candidates) {
    try {
      if (!c || !existsSync(c) || isElectronBinary(c)) continue;
      const real = realpathSync(c);
      const ver = run(real, ["-p", "process.versions.node"]);
      if (ver.status !== 0) continue;
      const version = (ver.stdout || "").trim();
      if (!/^\d+\.\d+\./.test(version)) continue;
      return { path: real, version };
    } catch {
      // try next
    }
  }
  return null;
}

function copySystemNodeWithLibs(sourcePath) {
  ensureDir(outDir);
  cpSync(sourcePath, outNode);
  if (!isWin) chmodSync(outNode, 0o755);

  // Homebrew node links against @rpath/libnode.*.dylib — copy sibling libs.
  if (isMac) {
    const otool = run("otool", ["-L", sourcePath]);
    if (otool.status === 0) {
      const lines = otool.stdout.split("\n").slice(1);
      for (const line of lines) {
        const m = line.trim().match(/^(\S+)/);
        if (!m) continue;
        let lib = m[1];
        if (!lib.includes("libnode")) continue;
        if (lib.startsWith("@rpath/")) {
          // Resolve relative to the binary's cellar lib dir
          const guessed = [
            join(dirname(sourcePath), lib.slice("@rpath/".length)),
            join(dirname(sourcePath), "..", "lib", lib.slice("@rpath/".length)),
          ];
          for (const g of guessed) {
            if (existsSync(g)) {
              lib = g;
              break;
            }
          }
        }
        if (existsSync(lib) && !lib.startsWith("@")) {
          const dest = join(outDir, lib.split("/").pop());
          cpSync(lib, dest);
          try { chmodSync(dest, 0o755); } catch { /* ignore */ }
          console.log(`Copied linked lib ${dest}`);
        }
      }
    }
    // Fix rpath so bin/node finds libnode next to itself
    run("install_name_tool", ["-add_rpath", "@loader_path", outNode]);
  }
}

async function main() {
  let meta;
  try {
    meta = await installOfficialNodeDist();
    console.log(`Bundled official Node ${meta.version}`);
  } catch (error) {
    if (crossBuild) {
      // Cross-build has no usable fallback — the host binary would not run on
      // the target platform. Surface the failure instead of silently bundling
      // a wrong-platform node.
      console.error(`Official Node dist for ${target} unavailable:`, error instanceof Error ? error.message : error);
      process.exit(1);
    }
    console.warn(
      `Official Node dist unavailable (${error instanceof Error ? error.message : error}); falling back to system Node + libs`,
    );
    const sys = resolveSystemNode();
    if (!sys) {
      console.error("No Node runtime available to bundle.");
      process.exit(1);
    }
    copySystemNodeWithLibs(sys.path);
    meta = { version: sys.version, source: sys.path };
    console.log(`Bundled system Node ${sys.version} from ${sys.path}`);
  }

  if (crossBuild) {
    // The target node binary cannot run on this host — verify the file exists
    // and record metadata, but skip execution smoke checks.
    const sizeMb = (statSync(outNode).size / (1024 * 1024)).toFixed(1);
    writeFileSync(
      join(outDir, "node-version.txt"),
      `${nodeVersion}\nsource=${meta.source}\ntarget=${target} (cross-build, smoke skipped)\n`,
      "utf8",
    );
    console.log(`Runtime ready: ${outNode} (${sizeMb} MB) [cross-build, smoke skipped]`);
    return;
  }

  // Verify the binary runs
  const smoke = run(outNode, ["-p", "process.versions.node"]);
  if (smoke.status !== 0) {
    console.error("Bundled Node failed to execute:");
    console.error(smoke.stderr || smoke.stdout);
    process.exit(1);
  }
  const sizeMb = (statSync(outNode).size / (1024 * 1024)).toFixed(1);
  writeFileSync(
    join(outDir, "node-version.txt"),
    `${(smoke.stdout || "").trim()}\nsource=${meta.source}\n`,
    "utf8",
  );
  console.log(`Runtime ready: ${outNode} (${sizeMb} MB)`);

  // node-pty smoke (best-effort)
  const ptyPath = join(standalone, "node_modules", "node-pty");
  if (existsSync(ptyPath)) {
    const shell = isWin ? "cmd.exe" : "/bin/sh";
    const args = isWin ? [] : ["-c", "echo ok"];
    const test = run(
      outNode,
      [
        "-e",
        `const p=require(${JSON.stringify(ptyPath)});` +
          `const t=p.spawn(${JSON.stringify(shell)}, ${JSON.stringify(args)}, {name:'xterm',cols:40,rows:12,cwd:process.cwd()});` +
          `setTimeout(()=>{try{t.kill()}catch{};process.exit(0)},300);`,
      ],
      { cwd: standalone, timeout: 5000 },
    );
    if (test.status === 0) console.log("Bundled Node + node-pty OK");
    else console.warn("Warning: node-pty smoke failed:\n", (test.stderr || test.stdout || "").slice(0, 500));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
