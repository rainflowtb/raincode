"use strict";
/**
 * LAN HTTP adapter — the product's only web server (off by default).
 *
 * Serves the desktop-dist SPA statically (index.html fallback, same resolution
 * rules as the app:// protocol) and forwards /api/* to the agent runtimes via
 * runtime-host's requestRuntime, so route handlers and the light/heavy split
 * are shared with the desktop window unchanged. When an access key is
 * configured the gate runs before anything else: browsers get a minimal login
 * page that sets an HttpOnly cookie, /api/* gets 401 JSON.
 *
 * Every forwarded request is marked `stream: true` — the runtime answers all
 * of them as open/chunk/end, which pipes naturally onto the HTTP response and
 * keeps SSE incremental. There is no SSE path list to keep in sync.
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { requestRuntime } = require("./runtime-host");
const { resolveAsset, MIME } = require("./app-protocol");

const LAN_PORT = 39141;
const AUTH_COOKIE = "raincode_lan";
const AUTH_PATH = "/__lan-auth";
/** Mirrors the old Next server's proxyClientMaxBodySize headroom. */
const MAX_BODY_BYTES = 110 * 1024 * 1024;

/** @type {http.Server | null} */
let server = null;
/** @type {{ running: boolean, error: string | null }} */
let state = { running: false, error: null };

/** SHA-256 hex of the key is both the cookie value and the compared secret. */
function keyToken(key) {
  return crypto.createHash("sha256").update(String(key)).digest("hex");
}

/** @param {string | undefined} header */
function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function tokenMatches(presented, expected) {
  if (!presented) return false;
  const a = Buffer.from(String(presented));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Bilingual static page — LAN visitors' locale is unknown at this layer. */
function loginPage(failed) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RainCode</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         font-family: -apple-system, "Segoe UI", sans-serif; background: #f5f5f4; color: #1c1917; }
  form { display: flex; flex-direction: column; gap: 12px; width: min(320px, calc(100vw - 48px));
         padding: 24px; background: #fff; border: 1px solid #e7e5e4; border-radius: 12px; }
  h1 { font-size: 15px; margin: 0; }
  p { font-size: 12px; color: #78716c; margin: 0; }
  input { font-size: 14px; padding: 8px 10px; border: 1px solid #d6d3d1; border-radius: 8px; }
  button { font-size: 14px; padding: 8px 10px; border: 0; border-radius: 999px;
           background: #1c1917; color: #fff; cursor: pointer; }
  .err { color: #b91c1c; font-size: 12px; }
</style>
</head>
<body>
<form method="post" action="${AUTH_PATH}">
  <h1>RainCode</h1>
  <p>请输入访问密钥 / Enter the access key</p>
  ${failed ? '<p class="err">密钥不正确 / Wrong key</p>' : ""}
  <input type="password" name="key" autofocus autocomplete="off" required>
  <button type="submit">进入 / Continue</button>
</form>
</body>
</html>`;
}

function sendHtml(res, status, html) {
  const body = Buffer.from(html, "utf8");
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  res.end(body);
}

/** Collect the request body (base64'd downstream); 413 past the cap. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req.method === "GET" || req.method === "HEAD") {
      resolve(undefined);
      return;
    }
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(chunks.length ? Buffer.concat(chunks).toString("base64") : undefined));
    req.on("error", reject);
  });
}

/** Headers the runtimes should not see verbatim (hop-by-hop / host-local). */
function forwardHeaders(reqHeaders) {
  const drop = new Set(["host", "connection", "content-length", "accept-encoding"]);
  const out = {};
  for (const [name, value] of Object.entries(reqHeaders)) {
    if (typeof value !== "string" || drop.has(name)) continue;
    out[name] = value;
  }
  return out;
}

function forwardApi(req, res, url, body) {
  const handle = requestRuntime({
    method: req.method,
    path: url.pathname + url.search,
    headers: forwardHeaders(req.headers),
    body,
    bodyEncoding: body ? "base64" : undefined,
    stream: true,
    onEvent: (message) => {
      if (message.t === "open") {
        const headers = { ...(message.headers || {}) };
        // Length/encoding from the runtime no longer describe what we write.
        delete headers["content-length"];
        delete headers["content-encoding"];
        res.writeHead(message.status || 200, headers);
        return;
      }
      if (message.t === "chunk") {
        res.write(Buffer.from(message.chunk, "base64"));
        return;
      }
      if (message.t === "end") {
        res.end();
        return;
      }
      if (message.t === "err") {
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
        }
        res.end(JSON.stringify({ error: message.message || "runtime error" }));
      }
    },
  });
  // Client went away mid-request (tab closed, SSE superseded) — abort in the
  // runtime so its work does not pile up behind nobody.
  req.on("close", () => {
    if (!res.writableEnded) handle.close();
  });
  res.on("error", () => handle.close());
}

function serveStatic(res, distDir, pathname) {
  let filePath = resolveAsset(distDir, pathname);
  // SPA: unknown paths are client routes, not 404s.
  if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(distDir, "index.html");
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("Desktop UI not built — run npm run desktop:build");
    return;
  }
  const type = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
  // Hashed asset names are immutable; index.html must not be cached.
  const cacheControl = path.basename(filePath) === "index.html"
    ? "no-store"
    : "public, max-age=31536000, immutable";
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    "content-type": type,
    "content-length": stat.size,
    "cache-control": cacheControl,
  });
  fs.createReadStream(filePath).pipe(res);
}

/**
 * @param {{ key?: string, distDir: string }} options
 * @returns {Promise<{ running: boolean, port: number, urls: string[], error: string | null }>}
 */
async function startLanServer({ key, distDir }) {
  await stopLanServer();
  const token = key ? keyToken(key) : null;

  server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url || "/", "http://lan.invalid");

      if (token) {
        if (url.pathname === AUTH_PATH && req.method === "POST") {
          const body = await readBody(req).catch(() => undefined);
          const params = new URLSearchParams(
            body ? Buffer.from(body, "base64").toString("utf8") : "",
          );
          const presented = params.get("key") || "";
          if (presented && tokenMatches(keyToken(presented), token)) {
            res.writeHead(302, {
              location: "/",
              "set-cookie": `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax`,
            });
            res.end();
          } else {
            sendHtml(res, 401, loginPage(true));
          }
          return;
        }
        if (!tokenMatches(readCookie(req.headers.cookie, AUTH_COOKIE), token)) {
          if (url.pathname.startsWith("/api/")) {
            res.writeHead(401, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: "unauthorized" }));
          } else {
            sendHtml(res, 200, loginPage(false));
          }
          return;
        }
      }

      if (url.pathname.startsWith("/api/")) {
        let body;
        try {
          body = await readBody(req);
        } catch {
          res.writeHead(413, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "body too large" }));
          return;
        }
        forwardApi(req, res, url, body);
        return;
      }
      serveStatic(res, distDir, url.pathname);
    })().catch((error) => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      }
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });

  await new Promise((resolve) => {
    server.once("error", (error) => {
      state = {
        running: false,
        error: error && error.code === "EADDRINUSE"
          ? "port-busy"
          : (error instanceof Error ? error.message : String(error)),
      };
      server = null;
      resolve();
    });
    server.listen(LAN_PORT, "0.0.0.0", () => {
      state = { running: true, error: null };
      resolve();
    });
  });
  return getLanServerState();
}

async function stopLanServer() {
  const current = server;
  server = null;
  state = { running: false, error: null };
  if (!current) return;
  await new Promise((resolve) => current.close(resolve));
}

function lanUrls() {
  const urls = [`http://127.0.0.1:${LAN_PORT}`];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      urls.push(`http://${entry.address}:${LAN_PORT}`);
    }
  }
  return urls;
}

function getLanServerState() {
  return { running: state.running, port: LAN_PORT, urls: lanUrls(), error: state.error };
}

module.exports = { startLanServer, stopLanServer, getLanServerState, LAN_PORT };
