import type { AgentMessage, AssistantContentBlock, AssistantMessage, ImageContent, ThinkingContent, TextContent, ToolCallContent } from "./types";
import {
  AGENT_MODE_BRIEF_CUSTOM_TYPE,
  JOB_RESULTS_CUSTOM_TYPE,
  MEMORY_CONTEXT_CUSTOM_TYPE,
  SUBAGENT_REPORT_CUSTOM_TYPE,
  SUBAGENT_RESULTS_CUSTOM_TYPE,
} from "./types";

/** customTypes that exist for the model only and never render in the transcript. */
const HIDDEN_CONTEXT_CUSTOM_TYPES = new Set<string>([
  MEMORY_CONTEXT_CUSTOM_TYPE,
  AGENT_MODE_BRIEF_CUSTOM_TYPE,
  SUBAGENT_RESULTS_CUSTOM_TYPE,
  SUBAGENT_REPORT_CUSTOM_TYPE,
  JOB_RESULTS_CUSTOM_TYPE,
]);

/** Hidden model-only context (memory recall, mode briefing) never renders. */
export function isHiddenContextMessage(message: AgentMessage): boolean {
  return message.role === "custom" && HIDDEN_CONTEXT_CUSTOM_TYPES.has(message.customType ?? "");
}

interface DisplayOptions {
  isStreaming?: boolean;
}

export function isEmptyThinkingBlock(block: AssistantContentBlock, options: DisplayOptions = {}): block is ThinkingContent {
  return block.type === "thinking" && !block.deferred && !options.isStreaming && block.thinking.trim() === "";
}

export function getDisplayableAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): AssistantContentBlock[] {
  return (message.content ?? []).filter((block) => !isEmptyThinkingBlock(block, options));
}

export function getAssistantErrorMessage(
  message: AssistantMessage,
  options: DisplayOptions = {},
): string | null {
  if (options.isStreaming || message.stopReason !== "error") return null;
  return message.errorMessage?.trim() || "Unknown provider error";
}

/**
 * Re-extract prompt text + base64 images from a persisted user message —
 * the payload the rpc "continue" command needs to re-run a failed turn.
 * URL-sourced images cannot be re-sent and are dropped.
 */
export function getUserMessageTextAndImages(message: {
  content: string | (TextContent | ImageContent)[];
}): { text: string; images: Array<{ data: string; mimeType: string }> } {
  if (typeof message.content === "string") return { text: message.content, images: [] };
  const texts: string[] = [];
  const images: Array<{ data: string; mimeType: string }> = [];
  for (const block of message.content) {
    if (block.type === "text") {
      texts.push(block.text);
    } else if (block.type === "image" && block.source.type === "base64" && block.source.data) {
      images.push({ data: block.source.data, mimeType: block.source.media_type ?? "image/png" });
    }
  }
  return { text: texts.join("\n"), images };
}

function isFinalAnswerBlock(block: AssistantContentBlock): boolean {
  return block.type === "text" || block.type === "image";
}

export function splitFinalAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): { answerBlocks: AssistantContentBlock[]; processBlocks: AssistantContentBlock[] } {
  const blocks = getDisplayableAssistantBlocks(message, options);
  const lastProcessIndex = blocks.findLastIndex((block) => !isFinalAnswerBlock(block));
  if (lastProcessIndex === -1) {
    return { answerBlocks: blocks, processBlocks: [] };
  }
  return {
    answerBlocks: blocks.slice(lastProcessIndex + 1),
    processBlocks: blocks.slice(0, lastProcessIndex + 1),
  };
}

export function countToolCallBlocks(blocks: AssistantContentBlock[]): number {
  return blocks.filter((block): block is ToolCallContent => block.type === "toolCall").length;
}

/** Format a measured duration the way Hermes labels thinking ("12s", "1:05"). */
export function formatThoughtDuration(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  if (whole < 60) return `${whole}s`;
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
