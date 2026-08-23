/**
 * Wrap the builtin read tool so text outputs carry 1-based `N:line` numbers and
 * every read records a file observation (lib/file-observations.ts) — that
 * observation is what makes the edit tool's read-before-edit / stale guards
 * possible.
 *
 * Images and error-shaped outputs pass through unchanged.
 */
import { readFileSync } from "fs";
import { isAbsolute, relative, resolve } from "path";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { fetchGithubRef, parseGithubRef } from "./github";
import { normalizeLf } from "./literal-edit";
import { recordFileObservation } from "./file-observations";

type ContentBlock = { type: string; text?: string; data?: string; mimeType?: string };

type ReadToolDefinitionLike = {
  name: string;
  description?: string;
  promptGuidelines?: string[];
  execute: (
    toolCallId: string,
    args: { path: string; offset?: number; limit?: number },
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<{ content: ContentBlock[]; details?: unknown }>;
};

function displayPath(cwd: string, pathValue: string): string {
  const abs = isAbsolute(pathValue) ? pathValue : resolve(cwd, pathValue);
  const rel = relative(cwd, abs);
  return rel && !rel.startsWith("..") ? rel : abs;
}

/**
 * Rebuild text as numbered `N:line` rows (1-based, offset-aware) and record a
 * whole-file observation so a later edit passes the fresh check.
 */
export function formatReadNumbered(
  cwd: string,
  pathValue: string,
  text: string,
  offset?: number,
): { text: string } {
  // Observe the full on-disk file (not just the slice) so edit's stale check
  // compares against what the agent actually saw.
  try {
    const abs = isAbsolute(pathValue) ? pathValue : resolve(cwd, pathValue);
    const full = readFileSync(abs, "utf8");
    recordFileObservation(abs, normalizeLf(full));
  } catch {
    // Virtual or unreadable paths: no observation, edit will ask for a read.
  }

  const startLine = offset && offset > 0 ? offset : 1;
  const rawLines = normalizeLf(text).split("\n");
  // Drop trailing empty from final newline for numbering.
  const lines =
    rawLines.length > 0 && rawLines[rawLines.length - 1] === ""
      ? rawLines.slice(0, -1)
      : rawLines;

  const body = lines.map((line, i) => {
    // Avoid double-numbering if the content already carries our N: prefix.
    if (/^\d+:/.test(line)) return line;
    return `${startLine + i}:${line}`;
  }).join("\n");

  return { text: `--- ${displayPath(cwd, pathValue)} ---\n${body}` };
}

export function createRainCodeReadToolDefinition(
  cwd: string,
): ReturnType<typeof createReadToolDefinition> {
  const def = createReadToolDefinition(cwd) as unknown as ReadToolDefinitionLike;

  def.description =
    (def.description ?? "Read file contents") +
    " Text files are returned as 1-based N:line numbered rows; the edit tool matches literal " +
    "text (not line numbers), so copy oldText from this output. Reading also authorizes a " +
    "later edit of the same file. " +
    "Also supports GitHub virtual paths: pr://N, pr://N/diff, issue://N (requires gh CLI).";
  def.promptGuidelines = [
    ...(def.promptGuidelines ?? []),
    "Read a file before editing it: edit refuses files you have not read (or written) this session, and files that changed since the read — re-read to refresh.",
    "For GitHub PRs/issues use read path pr://N or issue://N (or the github tool).",
  ];

  const originalExecute = def.execute;
  def.execute = async (toolCallId, args, signal, onUpdate, ctx) => {
    // Virtual GitHub refs — never hit the filesystem.
    const path = typeof args?.path === "string" ? args.path : "";
    const ghRef = path ? parseGithubRef(path) : null;
    if (ghRef) {
      const fetched = await fetchGithubRef(cwd, ghRef);
      return {
        content: [{ type: "text", text: fetched.text }],
        details: { github: true, ref: ghRef, ...(typeof fetched.details === "object" && fetched.details ? fetched.details as object : {}) },
        ...(fetched.ok ? {} : { isError: true }),
      };
    }

    const result = await originalExecute(toolCallId, args, signal, onUpdate, ctx);
    try {
      const blocks = Array.isArray(result.content) ? result.content : [];
      const hasImage = blocks.some((b) => b.type === "image");
      if (hasImage) return result;

      const textBlocks = blocks.filter((b) => b.type === "text" && typeof b.text === "string");
      if (textBlocks.length === 0) return result;

      // Only rewrite pure text reads (single text block is the common case)
      const first = textBlocks[0]!;
      if (!path || !first.text) return result;

      // Skip error-like / special messages
      if (
        first.text.startsWith("[Line ") ||
        first.text.startsWith("Read image") ||
        first.text.startsWith("Offset ")
      ) {
        return result;
      }

      const { text } = formatReadNumbered(cwd, path, first.text, args?.offset);
      const rest = blocks.filter((b) => b !== first);
      return {
        ...result,
        content: [{ type: "text", text }, ...rest],
      };
    } catch {
      return result;
    }
  };

  return def as unknown as ReturnType<typeof createReadToolDefinition>;
}
