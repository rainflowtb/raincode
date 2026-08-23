/**
 * RainCode write tool — SDK write with workspace-turn journal recording.
 * Single owner for write-path mutation capture (pairs with agent-edit-tool).
 * Successful writes record a file observation so a follow-up edit passes the
 * read-before-edit guard without a separate read.
 */
import { existsSync, readFileSync } from "fs";
import { mkdir as fsMkdir, writeFile as fsWriteFile } from "fs/promises";
import { isAbsolute, resolve } from "path";
import { createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { normalizeLf } from "./literal-edit";
import { recordFileObservation } from "./file-observations";
import { recordFileMutation } from "./workspace-turn-journal";

export type RainCodeWriteToolOptions = {
  getSessionId?: () => string | undefined;
};

type ContentBlock = { type: string; text?: string };

type WriteToolDefinitionLike = {
  name: string;
  description?: string;
  promptGuidelines?: string[];
  execute: (
    toolCallId: string,
    args: { path: string; content: string },
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<{ content: ContentBlock[]; details?: unknown }>;
};

export function createRainCodeWriteToolDefinition(
  cwd: string,
  options: RainCodeWriteToolOptions = {},
): ReturnType<typeof createWriteToolDefinition> {
  const def = createWriteToolDefinition(cwd, {
    operations: {
      mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
      writeFile: async (absolutePath, content) => {
        let before: string | null = null;
        if (existsSync(absolutePath)) {
          try {
            before = readFileSync(absolutePath, "utf8");
          } catch {
            before = null;
          }
        }
        await fsWriteFile(absolutePath, content, "utf-8");
        const sessionId = options.getSessionId?.();
        if (sessionId) {
          recordFileMutation(sessionId, {
            path: absolutePath,
            kind: before == null ? "create" : "edit",
            before,
            after: content,
          });
        }
      },
    },
  }) as unknown as WriteToolDefinitionLike;

  def.description =
    (def.description ?? "Write content to a file.") +
    " Use write to create files or fully replace them; use edit for targeted changes. " +
    "A file you just wrote can be edited directly (no re-read needed).";
  def.promptGuidelines = [
    ...(def.promptGuidelines ?? []),
    "write creates or fully replaces a file; for targeted changes use edit with exact oldText from a read.",
  ];

  const originalExecute = def.execute;
  def.execute = async (toolCallId, args, signal, onUpdate, ctx) => {
    const result = await originalExecute(toolCallId, args, signal, onUpdate, ctx);
    const path = typeof args?.path === "string" ? args.path : "";
    if (!path) return result;
    // Record what is actually on disk so the next edit's fresh check matches.
    const abs = isAbsolute(path) ? path : resolve(cwd, path);
    try {
      const onDisk = existsSync(abs) ? readFileSync(abs, "utf8") : null;
      if (onDisk != null) recordFileObservation(abs, normalizeLf(onDisk));
    } catch {
      // best-effort: edit will simply ask for a read
    }
    return result;
  };

  return def as unknown as ReturnType<typeof createWriteToolDefinition>;
}
