/**
 * Agent `browser` tool: drives the desktop app's pooled Chromium views through
 * the reverse-IPC bridge (lib/browser-bridge.ts) — snapshot-by-ref interactions,
 * in-page evaluate/wait, and screenshots.
 */
import { Type } from "typebox";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { browserMainRequest, isBrowserBridgeAvailable } from "./browser-bridge";
import { errorResult, type ToolDefinitionLike, type ToolResult, type ToolResultContent } from "./agent-tool-types";

type BrowserState = {
  viewId: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Logical viewport — the size the page keeps while the panel is hidden. */
  viewport?: { width: number; height: number };
};

const UNAVAILABLE_TEXT = "Browser is only available in the RainCode desktop app.";
const SNAPSHOT_TEXT_LIMIT = 6000;
const EVALUATE_TEXT_LIMIT = 8000;

/**
 * In-page snapshot: re-tags visible interactive elements data-rc-ref="1..n"
 * and returns title/url + numbered ref list + visible text (truncated).
 */
const SNAPSHOT_EXPRESSION = `(() => {
  const sel = 'a[href],button,input,select,textarea,[role="button"],[role="link"],[contenteditable="true"],summary';
  const lines = [];
  let n = 0;
  for (const el of Array.from(document.querySelectorAll(sel))) {
    const r = el.getBoundingClientRect();
    const st = window.getComputedStyle(el);
    if (r.width < 1 || r.height < 1 || st.visibility === 'hidden' || st.display === 'none') continue;
    n += 1;
    el.setAttribute('data-rc-ref', String(n));
    const raw = el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || '';
    const label = String(raw).trim().replace(/\\s+/g, ' ').slice(0, 80) || el.tagName.toLowerCase();
    const href = el.getAttribute('href');
    lines.push('[' + n + '] <' + el.tagName.toLowerCase() + '> "' + label + '"' + (href ? ' (' + href + ')' : ''));
  }
  const text = (document.body ? document.body.innerText : '').slice(0, ${SNAPSHOT_TEXT_LIMIT});
  return 'Title: ' + document.title + '\\nURL: ' + location.href +
    '\\n\\nInteractive elements:\\n' + (lines.join('\\n') || '(none)') +
    '\\n\\nPage text:\\n' + text;
})()`;

function clickExpression(ref: number): string {
  return `(async () => {
    const el = document.querySelector('[data-rc-ref="${ref}"]');
    if (!el) return 'ERROR: no element with ref ${ref} — stale snapshot, run snapshot again.';
    el.scrollIntoView({ block: 'center' });
    el.click();
    await new Promise((r) => setTimeout(r, 300));
    return 'Clicked [${ref}] <' + el.tagName.toLowerCase() + '> — now at ' + location.href;
  })()`;
}

function fillExpression(ref: number, value: string): string {
  return `(async () => {
    const el = document.querySelector('[data-rc-ref="${ref}"]');
    if (!el) return 'ERROR: no element with ref ${ref} — stale snapshot, run snapshot again.';
    const v = ${JSON.stringify(value)};
    if (el.isContentEditable) el.innerText = v;
    else el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'Filled [${ref}] <' + el.tagName.toLowerCase() + '>.';
  })()`;
}

function waitForExpression(selector: string, timeoutMs: number): string {
  return `(async () => {
    const sel = ${JSON.stringify(selector)};
    const timeout = ${Math.max(0, Math.round(timeoutMs))};
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (document.querySelector(sel)) return 'Found: ' + sel;
      await new Promise((r) => setTimeout(r, 100));
    }
    return 'TIMEOUT: ' + sel + ' not found within ' + timeout + 'ms';
  })()`;
}

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function formatState(state: BrowserState): string {
  const vp = state.viewport ? `viewport: ${state.viewport.width}x${state.viewport.height}` : "viewport: (unknown)";
  return `url: ${state.url || "(none)"}\ntitle: ${state.title || "(none)"}\nloading: ${state.loading}\ncanGoBack: ${state.canGoBack}\ncanGoForward: ${state.canGoForward}\n${vp}`;
}

export function createBrowserTool(getSessionId: () => string | undefined): ToolDefinitionLike {
  const baseViewId = () => getSessionId() || "scratch";
  // Tabs share one pool: "main" is the base view, any other name is a sibling
  // view keyed "<base>/<tab>" — so parallel pages stay open in one session.
  const viewId = (tab: unknown) => {
    const name = typeof tab === "string" ? tab.trim() : "";
    return !name || name === "main" ? baseViewId() : `${baseViewId()}/${name.replaceAll("/", "_")}`;
  };

  return {
    name: "browser",
    label: "browser",
    description:
      "Drive the built-in desktop browser panel (a real Chromium view in the app's sidebar): navigate, " +
      "snapshot interactive elements as numbered refs, click/fill by ref, evaluate JavaScript, " +
      "wait for a selector, take screenshots, and debug — console logs/exceptions and network " +
      "requests (status, timing, response bodies) are captured continuously per tab. Desktop app only. " +
      "Pages always open IN THE SIDEBAR; pass width to lay a page out at that resolution " +
      "(e.g. 1440 desktop / 390 mobile) — the panel fit-zooms it.",
    promptSnippet: "Browse the web in the desktop app's sidebar browser: navigate, then act by element ref",
    promptGuidelines: [
      "Workflow: navigate, then snapshot, then click/fill using the numbered [ref] ids from the snapshot.",
      "Refs go stale after any navigation or DOM change — run snapshot again before the next action.",
      "localhost and intranet URLs are fine: the browser runs on the user's machine with their logins.",
      "Need several pages at once? Pass a distinct `tab` name (e.g. \"docs\", \"issue-123\") to keep them open side by side; the default tab is \"main\". Use the tabs action to list what is open, and close tabs you are done with.",
      "Debugging: console and network read buffers captured since the last navigation (SPA route changes keep them) — reproduce the issue first, then read. Use response_body with a request id from network to inspect an API payload.",
      "Viewport semantics: width = page layout width (the panel fit-zooms to show all of it; a hidden sidebar parks the view at this size, never 0). height = parked layout height.",
      "Screenshots capture the zoomed panel (full logical width included) and need the panel visible.",
    ],
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("navigate"),
          Type.Literal("snapshot"),
          Type.Literal("click"),
          Type.Literal("fill"),
          Type.Literal("evaluate"),
          Type.Literal("screenshot"),
          Type.Literal("wait_for"),
          Type.Literal("console"),
          Type.Literal("network"),
          Type.Literal("response_body"),
          Type.Literal("state"),
          Type.Literal("tabs"),
          Type.Literal("close"),
          Type.Literal("go_back"),
          Type.Literal("go_forward"),
          Type.Literal("reload"),
        ],
        { description: "Browser action to perform" },
      ),
      url: Type.Optional(Type.String({ description: "URL for navigate (https:// added when missing)" })),
      ref: Type.Optional(Type.Number({ description: "Element ref from the latest snapshot (click/fill)" })),
      value: Type.Optional(Type.String({ description: "Text to set for fill" })),
      expression: Type.Optional(Type.String({ description: "JavaScript expression for evaluate" })),
      selector: Type.Optional(Type.String({ description: "CSS selector for wait_for" })),
      timeoutMs: Type.Optional(Type.Number({ description: "wait_for timeout in ms (default 10000)" })),
      tab: Type.Optional(Type.String({ description: 'Tab name; default "main". Use distinct names to keep multiple pages open.' })),
      level: Type.Optional(Type.String({ description: "console: only show this level (e.g. error, warning)" })),
      limit: Type.Optional(Type.Number({ description: "console/network: max entries to return (default 50, newest last)" })),
      sinceSeq: Type.Optional(Type.Number({ description: "console/network: only entries newer than this buffer seq" })),
      requestId: Type.Optional(Type.String({ description: "response_body: request id from the network action output" })),
      width: Type.Optional(Type.Number({ description: "Page layout width in px (320–7680). The sidebar browser lays out the page at this width and fit-zooms it into the panel (window.innerWidth reports this value); while the sidebar is hidden the parked view uses it at zoom 1. Default: panel width (no zoom)." })),
      height: Type.Optional(Type.Number({ description: "Parked height in px (320–7680, default 720) — the layout height while the sidebar is hidden." })),
    }),
    async execute(_toolCallId, args) {
      if (!isBrowserBridgeAvailable()) return textResult(UNAVAILABLE_TEXT);
      const id = viewId(args.tab);
      const action = String(args.action ?? "");
      try {
        const target = { viewId: id };

        // Optional viewport override — the page lays out at this width
        // (sidebar fit-zooms it; the parked view keeps it at zoom 1).
        if (Number.isFinite(Number(args.width)) || Number.isFinite(Number(args.height))) {
          await browserMainRequest("setViewport", { viewId: id, width: args.width, height: args.height });
        }
        switch (action) {
          case "navigate": {
            const state = await browserMainRequest<BrowserState>("navigate", { ...target, url: String(args.url ?? "") });
            return textResult(`Navigated.\n${formatState(state)}`);
          }
          case "snapshot": {
            const text = await browserMainRequest<unknown>("evaluate", { ...target, expression: SNAPSHOT_EXPRESSION });
            return textResult(typeof text === "string" ? text : JSON.stringify(text));
          }
          case "click": {
            const ref = Number(args.ref);
            if (!Number.isFinite(ref)) return errorResult(new Error("ref (number) is required for click"));
            const text = await browserMainRequest<unknown>("evaluate", { ...target, expression: clickExpression(ref) });
            return textResult(String(text));
          }
          case "fill": {
            const ref = Number(args.ref);
            if (!Number.isFinite(ref)) return errorResult(new Error("ref (number) is required for fill"));
            const text = await browserMainRequest<unknown>("evaluate", {
              ...target,
              expression: fillExpression(ref, String(args.value ?? "")),
            });
            return textResult(String(text));
          }
          case "evaluate": {
            const value = await browserMainRequest<unknown>("evaluate", {
              ...target,
              expression: String(args.expression ?? ""),
            });
            const json = JSON.stringify(value, null, 2) ?? "undefined";
            return textResult(json.length > EVALUATE_TEXT_LIMIT ? `${json.slice(0, EVALUATE_TEXT_LIMIT)}… (truncated)` : json);
          }
          case "wait_for": {
            const selector = String(args.selector ?? "");
            if (!selector) return errorResult(new Error("selector is required for wait_for"));
            const text = await browserMainRequest<unknown>("evaluate", {
              ...target,
              // Capped below the bridge's 45s request timeout so a long wait
              // fails with the in-page TIMEOUT text, not a transport error.
              expression: waitForExpression(
                selector,
                Math.min(typeof args.timeoutMs === "number" ? args.timeoutMs : 10_000, 30_000),
              ),
            });
            return textResult(String(text));
          }
          case "screenshot": {
            const shot = await browserMainRequest<{ dataBase64: string; width: number; height: number }>(
              "screenshot",
              target,
            );
            const shotName = id.replace(/[^a-zA-Z0-9_-]/g, "_");
            const file = path.join(os.tmpdir(), `raincode-browser-${shotName}-${Date.now()}.png`);
            fs.writeFileSync(file, Buffer.from(shot.dataBase64, "base64"));
            const content: ToolResultContent[] = [
              { type: "image", data: shot.dataBase64, mimeType: "image/png" },
              { type: "text", text: `Screenshot (${shot.width}x${shot.height}) saved to ${file}` },
            ];
            return { content, details: { path: file, width: shot.width, height: shot.height } };
          }
          case "state":
            return textResult(formatState(await browserMainRequest<BrowserState>("getState", target)));
          case "tabs": {
            const tabs = await browserMainRequest<Array<{ tab: string; url: string; title: string }>>("list", {
              viewId: baseViewId(),
            });
            if (tabs.length === 0) return textResult("No open tabs.");
            return textResult(tabs.map((t) => `${t.tab}: ${t.url || "(blank)"} — ${t.title || "(untitled)"}`).join("\n"));
          }
          case "close": {
            await browserMainRequest("close", target);
            return textResult(`Closed tab "${typeof args.tab === "string" && args.tab.trim() ? args.tab.trim() : "main"}".`);
          }
          case "console": {
            const res = await browserMainRequest<{
              entries: Array<{ seq: number; level: string; text: string }>;
              lastSeq: number;
            }>("getConsole", { ...target, sinceSeq: Number(args.sinceSeq) || 0 });
            const level = typeof args.level === "string" ? args.level.trim() : "";
            const matched = level ? res.entries.filter((e) => e.level === level) : res.entries;
            const shown = matched.slice(-Math.min(Number(args.limit) || 50, 200));
            if (shown.length === 0) {
              return textResult(`No console entries${level ? ` at level "${level}"` : ""}. (buffer lastSeq=${res.lastSeq})`);
            }
            return textResult([
              ...shown.map((e) => `[${e.seq}] ${e.level}: ${e.text}`),
              `\n(${matched.length} matched; buffer lastSeq=${res.lastSeq} — pass sinceSeq to read only newer entries)`,
            ].join("\n"));
          }
          case "network": {
            const res = await browserMainRequest<{
              entries: Array<{
                seq: number;
                id: string;
                method: string;
                url: string;
                type: string;
                status?: number;
                sizeKB?: number;
                failed?: string;
              }>;
              lastSeq: number;
            }>("getNetwork", { ...target, sinceSeq: Number(args.sinceSeq) || 0 });
            const needle = typeof args.url === "string" ? args.url.trim().toLowerCase() : "";
            const matched = needle ? res.entries.filter((e) => e.url.toLowerCase().includes(needle)) : res.entries;
            const shown = matched.slice(-Math.min(Number(args.limit) || 50, 200));
            if (shown.length === 0) {
              return textResult(`No network requests${needle ? ` matching "${needle}"` : ""}. (buffer lastSeq=${res.lastSeq})`);
            }
            return textResult([
              ...shown.map((e) => {
                const status = e.failed ? `FAILED(${e.failed})` : (e.status ?? "pending");
                const size = typeof e.sizeKB === "number" ? `, ${e.sizeKB}KB` : "";
                return `[${e.id}] ${status} ${e.method} ${e.url} — ${e.type}${size}`;
              }),
              `\n(${matched.length} matched; buffer lastSeq=${res.lastSeq} — use response_body with a request id to inspect a payload)`,
            ].join("\n"));
          }
          case "response_body": {
            const requestId = String(args.requestId ?? "");
            if (!requestId) return errorResult(new Error("requestId is required for response_body (get one from the network action)"));
            const res = await browserMainRequest<{ body: string }>("getResponseBody", { ...target, requestId });
            return textResult(res.body || "(empty body)");
          }
          case "go_back":
            return textResult(formatState(await browserMainRequest<BrowserState>("goBack", target)));
          case "go_forward":
            return textResult(formatState(await browserMainRequest<BrowserState>("goForward", target)));
          case "reload":
            return textResult(formatState(await browserMainRequest<BrowserState>("reload", target)));
          default:
            return errorResult(new Error(`unknown browser action: ${action}`));
        }
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}
