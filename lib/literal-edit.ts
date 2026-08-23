/**
 * Literal edit engine for RainCode. Single owner for edit-tool file mutation.
 *
 * Model contract (deepseek-harness style): { path, edits: [{ oldText, newText, replaceAll? }] }
 * - oldText is matched as literal text. The only leniency is line-ending
 *   normalization (CRLF/CR → LF for matching, original endings restored on write).
 * - oldText must occur exactly once unless replaceAll is true; ambiguity is an
 *   error that reports the match count and line numbers.
 * - JS/TS results are parse-checked before write; unparsable = rejected,
 *   file untouched. All edits in one call are planned against the same
 *   snapshot and applied atomically (overlap = error).
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { isAbsolute, relative, resolve } from "path";
import { checkSourceSyntax, formatSyntaxGuardFailure } from "./edit-syntax-guard";

export type LiteralEdit = {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
};

export type LiteralEditResult = {
  /** Absolute path written. */
  path: string;
  /** Number of edit entries applied. */
  applied: number;
  /** Total occurrences replaced (≥ applied; replaceAll can replace many). */
  replacements: number;
  /** Unified diff for the chat UI (SplitPatchView). */
  diff: string;
  /** Alias of diff for presentation.patch / patchFromToolDetails. */
  patch: string;
  /** Soft size discipline signal for agents (not an error). */
  largeFileWarning?: string;
  summary: string;
};

/** Soft cap aligned with AGENTS.md size discipline — warn, do not block. */
export const LARGE_FILE_LINE_WARN = 800;

export function normalizeLf(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Line count for soft-warn (trailing empty from final newline does not inflate). */
export function countContentLines(content: string): number {
  if (!content) return 0;
  const normalized = normalizeLf(content);
  if (normalized === "") return 0;
  const parts = normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
  return parts.length;
}

export function largeFileEditWarning(displayPath: string, content: string): string | undefined {
  const lines = countContentLines(content);
  if (lines < LARGE_FILE_LINE_WARN) return undefined;
  return (
    `Note: ${displayPath} is ~${lines} lines (≥${LARGE_FILE_LINE_WARN}). ` +
    `Prefer extract-module before stacking more edits on this hot file.`
  );
}

function displayPath(cwd: string, abs: string): string {
  const rel = relative(cwd, abs);
  return rel && !rel.startsWith("..") ? rel : abs;
}

function preserveLineEndings(original: string, lfContent: string): string {
  if (original.includes("\r\n")) return lfContent.replace(/\n/g, "\r\n");
  return lfContent;
}

/** Minimal unified diff for chat SplitPatchView (single hunk, 3 lines of context). */
export function buildUnifiedDiff(path: string, before: string, after: string): string {
  const a = normalizeLf(before).replace(/\n$/, "").split("\n");
  const b = normalizeLf(after).replace(/\n$/, "").split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let aEnd = a.length - 1;
  let bEnd = b.length - 1;
  while (aEnd >= start && bEnd >= start && a[aEnd] === b[bEnd]) {
    aEnd--;
    bEnd--;
  }
  const context = 3;
  const hStart = Math.max(0, start - context);
  const aHEnd = Math.min(a.length - 1, aEnd + context);
  const bHEnd = Math.min(b.length - 1, bEnd + context);

  const oldCount = a.length === 0 ? 0 : aHEnd - hStart + 1;
  const newCount = b.length === 0 ? 0 : bHEnd - hStart + 1;
  const linesOut: string[] = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${hStart + 1},${Math.max(oldCount, 0)} +${hStart + 1},${Math.max(newCount, 0)} @@`,
  ];
  for (let i = hStart; i < start; i++) linesOut.push(` ${a[i] ?? ""}`);
  for (let i = start; i <= aEnd; i++) {
    if (i >= 0 && i < a.length) linesOut.push(`-${a[i]}`);
  }
  for (let i = start; i <= bEnd; i++) {
    if (i >= 0 && i < b.length) linesOut.push(`+${b[i]}`);
  }
  const afterStartA = aEnd + 1;
  const ctxLines = Math.min(context, a.length - afterStartA, b.length - (bEnd + 1));
  for (let k = 0; k < ctxLines; k++) {
    linesOut.push(` ${a[afterStartA + k] ?? ""}`);
  }
  return linesOut.join("\n") + "\n";
}

/** All start offsets of needle in haystack (literal). */
function findOccurrences(haystack: string, needle: string): number[] {
  const out: number[] = [];
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    out.push(idx);
    idx = haystack.indexOf(needle, idx + 1);
  }
  return out;
}

/** 1-based line number of a character offset. */
function lineOfOffset(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

function formatMatchLines(text: string, offsets: number[]): string {
  const lines = offsets.slice(0, 10).map((o) => lineOfOffset(text, o));
  const suffix = offsets.length > 10 ? `, … +${offsets.length - 10} more` : "";
  return `lines ${lines.join(", ")}${suffix}`;
}

/**
 * Apply literal edits to one file. Throws Error with a model-actionable
 * message on any validation failure; the file is only written when every
 * edit applied cleanly and the result still parses (JS/TS).
 */
export function applyLiteralEdits(
  cwd: string,
  pathValue: string,
  edits: LiteralEdit[],
): LiteralEditResult {
  if (!edits.length) throw new Error("edits must be a non-empty array of { oldText, newText, replaceAll? }");
  const abs = isAbsolute(pathValue) ? pathValue : resolve(cwd, pathValue);
  const rel = displayPath(cwd, abs);
  if (!existsSync(abs)) {
    throw new Error(`File not found: ${rel}. edit modifies existing files — use write to create new files.`);
  }
  const original = readFileSync(abs, "utf8");
  const content = normalizeLf(original);

  // Validate shapes first; locate matches only after replaceAll edits have
  // been applied so sequential edits in one call compose on fresh content.
  const singles: Array<{ oldText: string; newText: string; index: number }> = [];
  const replaceAlls: Array<{ oldText: string; newText: string; index: number }> = [];

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i]!;
    const oldText = normalizeLf(String(edit.oldText ?? ""));
    const newText = normalizeLf(String(edit.newText ?? ""));
    if (!oldText) {
      throw new Error(`edits[${i}].oldText must be a non-empty string.`);
    }
    if (oldText === newText) {
      throw new Error(`edits[${i}]: oldText and newText are identical — a no-op edit is never written. Fix the replacement text.`);
    }
    if (edit.replaceAll === true) {
      replaceAlls.push({ oldText, newText, index: i });
    } else {
      singles.push({ oldText, newText, index: i });
    }
  }

  let next = content;
  let replacements = 0;

  for (const p of replaceAlls) {
    const count = findOccurrences(next, p.oldText).length;
    if (count === 0) {
      throw new Error(
        `edits[${p.index}].oldText was not found in "${rel}". ` +
          `The text must match the file exactly (whitespace included) — re-read the file, then retry.`,
      );
    }
    replacements += count;
    next = next.split(p.oldText).join(p.newText);
  }

  if (singles.length > 0) {
    const located: Array<{ start: number; end: number; newText: string; index: number }> = [];
    for (const p of singles) {
      const offsets = findOccurrences(next, p.oldText);
      if (offsets.length === 0) {
        throw new Error(
          `edits[${p.index}].oldText was not found in "${rel}". ` +
            `The text must match the file exactly (whitespace included) — re-read the file, then retry.`,
        );
      }
      if (offsets.length > 1) {
        throw new Error(
          `edits[${p.index}].oldText matched ${offsets.length} times in "${rel}" (${formatMatchLines(next, offsets)}). ` +
            `Provide a more specific oldText with more surrounding context, or set replaceAll: true.`,
        );
      }
      replacements += 1;
      located.push({ start: offsets[0]!, end: offsets[0]! + p.oldText.length, newText: p.newText, index: p.index });
    }
    // Overlap check on the final application targets.
    const ordered = [...located].sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1]!;
      const curr = ordered[i]!;
      if (prev.end > curr.start) {
        throw new Error(
          `edits[${prev.index}] and edits[${curr.index}] overlap in "${rel}". ` +
            `Merge them into one edit or target disjoint regions.`,
        );
      }
    }
    located.sort((a, b) => b.start - a.start);
    for (const p of located) {
      next = next.slice(0, p.start) + p.newText + next.slice(p.end);
    }
  }

  const syntax = checkSourceSyntax(abs, next, cwd);
  if (!syntax.ok) {
    throw new Error(formatSyntaxGuardFailure(rel, syntax, next));
  }

  writeFileSync(abs, preserveLineEndings(original, next), "utf8");
  const before = content.endsWith("\n") ? content : `${content}\n`;
  const after = next.endsWith("\n") ? next : `${next}\n`;
  const diff = buildUnifiedDiff(rel, before, after);
  const warning = largeFileEditWarning(rel, next);
  const summary =
    `Edited ${rel} (${edits.length} edit(s), ${replacements} replacement(s)).` +
    (warning ? `\n${warning}` : "");
  return {
    path: abs,
    applied: edits.length,
    replacements,
    diff,
    patch: diff,
    largeFileWarning: warning,
    summary,
  };
}
