/**
 * RainCode edit tool — literal exact-match replacement (deepseek-harness style).
 *
 * Single accepted shape:
 *   { path, edits: [{ oldText, newText, replaceAll? }] }
 *
 * Design rules (see lib/literal-edit.ts and lib/file-observations.ts):
 * - oldText is matched literally; the only leniency is line-ending normalization.
 * - oldText must be unique in the file unless replaceAll: true. Ambiguity is an
 *   error carrying the match count + line numbers, never a guess.
 * - Read-before-edit is a hard constraint: a file that was never read/written by
 *   this runtime, or that changed on disk since (stale), is rejected with a
 *   single remedy — re-read, then retry. Stale-content edits cannot land silently.
 * - JS/TS results are parse-checked; unparsable would-be output is rejected and
 *   the file is left untouched.
 */
import { Type } from "typebox";
import { existsSync, readFileSync } from "fs";
import { isAbsolute, relative, resolve } from "path";
import { createEditToolDefinition } from "@earendil-works/pi-coding-agent";
import { formatFileOnDisk } from "./format-file";
import { applyLiteralEdits, normalizeLf, type LiteralEdit } from "./literal-edit";
import {
  checkFileObservation,
  recordFileObservation,
  withFileLock,
} from "./file-observations";
import { recordFileMutation } from "./workspace-turn-journal";

export type RainCodeEditToolOptions = {
  getSessionId?: () => string | undefined;
};

function displayRel(cwd: string, abs: string): string {
  const rel = relative(cwd, abs);
  return rel && !rel.startsWith("..") ? rel : abs;
}

const EDIT_USAGE =
  `edit requires { path, edits: [{ oldText, newText, replaceAll? }] }.\n` +
  `  • path: file to edit (absolute or relative to the working directory)\n` +
  `  • oldText: exact text to replace — copy it from a fresh read; must appear exactly once unless replaceAll is true\n` +
  `  • newText: replacement text (empty string deletes the match)\n` +
  `Read the file first — edit refuses files you have not read (or written) this session.`;

const EDIT_GUIDELINES = [
  "edit replaces literal text: oldText must match the file exactly (indentation included; line endings are normalized for you). By default it must match exactly once — on ambiguity include more surrounding context, or set replaceAll: true.",
  "Read the file before editing it. If edit reports the file changed since it was read, re-read and retry — never retry the same oldText blindly.",
  "Batch disjoint same-file changes as multiple entries in one edits[] call. To replace a whole construct, include it completely (opener through closer) in one oldText/newText pair.",
  "Use write only to create files or for inherently non-local rewrites; everything targeted goes through edit.",
];

export function createRainCodeEditToolDefinition(
  cwd: string,
  options: RainCodeEditToolOptions = {},
): ReturnType<typeof createEditToolDefinition> {
  const getSessionId = options.getSessionId;

  const def = {
    name: "edit",
    label: "edit",
    description:
      "Edit an existing file by replacing literal text. oldText must match exactly and appear " +
      "exactly once (unless replaceAll). The file must have been read (or written) first; if it " +
      "changed on disk since, re-read and retry. Batch disjoint same-file changes in one edits[] call.",
    promptSnippet: "Make precise file edits by exact literal replacement",
    promptGuidelines: EDIT_GUIDELINES,
    parameters: Type.Object({
      path: Type.String({ description: "File to edit (absolute or relative to the working directory)" }),
      edits: Type.Array(
        Type.Object({
          oldText: Type.String({
            description: "Exact literal text to replace. Must match the file byte-for-byte (line endings are normalized) and appear exactly once unless replaceAll is set.",
          }),
          newText: Type.String({ description: "Replacement text. Use an empty string to delete the match." }),
          replaceAll: Type.Optional(Type.Boolean({ description: "Replace every occurrence of oldText. Defaults to false." })),
        }),
        { description: "Literal replacements, planned against one snapshot and applied together. Each oldText must be unique unless replaceAll is set." },
      ),
    }),
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      // Explicit rejections for removed shapes — teach the current contract.
      if (typeof args?.input === "string" && args.input.trim()) {
        throw new Error(
          `edit no longer accepts hashline input ([path#TAG] SWAP/INS/DEL patches).\n${EDIT_USAGE}`,
        );
      }
      if (Array.isArray(args?.hunks)) {
        throw new Error(`edit no longer accepts { path, hunks }.\n${EDIT_USAGE}`);
      }
      const pathValue = typeof args?.path === "string" ? args.path.trim() : "";
      const editsRaw = Array.isArray(args?.edits) ? args.edits : null;
      if (!pathValue || !editsRaw || editsRaw.length === 0) {
        throw new Error(EDIT_USAGE);
      }
      const edits: LiteralEdit[] = editsRaw.map((row, i) => {
        const r = row as { oldText?: unknown; newText?: unknown; replaceAll?: unknown };
        if (typeof r?.oldText !== "string" || typeof r?.newText !== "string") {
          throw new Error(`edits[${i}] must be { oldText: string, newText: string, replaceAll?: boolean }.\n${EDIT_USAGE}`);
        }
        return { oldText: r.oldText, newText: r.newText, replaceAll: r.replaceAll === true };
      });

      const abs = isAbsolute(pathValue) ? pathValue : resolve(cwd, pathValue);
      const rel = displayRel(cwd, abs);

      return await withFileLock(abs, async () => {
        if (!existsSync(abs)) {
          // Engine owns the canonical "use write to create" error.
          applyLiteralEdits(cwd, pathValue, edits);
        }
        const before = readFileSync(abs, "utf8");
        const observation = checkFileObservation(abs, normalizeLf(before));
        if (observation === "unobserved") {
          throw new Error(`cannot edit "${rel}": the file has not been read in this session — read the file, then retry.`);
        }
        if (observation === "stale") {
          throw new Error(`cannot edit "${rel}": file changed since it was read — re-read the file, then retry.`);
        }

        const result = applyLiteralEdits(cwd, pathValue, edits);

        // Await formatting so the recorded observation matches on-disk content.
        try {
          await formatFileOnDisk(cwd, result.path);
        } catch {
          // best-effort
        }
        const after = readFileSync(result.path, "utf8");
        recordFileObservation(result.path, normalizeLf(after));

        const sessionId = getSessionId?.();
        if (sessionId && before !== after) {
          recordFileMutation(sessionId, { path: result.path, kind: "edit", before, after });
        }

        return {
          content: [{ type: "text", text: result.summary }],
          details: {
            mode: "literal",
            path: result.path,
            applied: result.applied,
            replacements: result.replacements,
            diff: result.diff,
            patch: result.patch,
            largeFileWarning: result.largeFileWarning,
          },
        };
      });
    },
  };

  return def as unknown as ReturnType<typeof createEditToolDefinition>;
}
