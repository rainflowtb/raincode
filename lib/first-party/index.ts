/**
 * First-party RainCode session factories. All built-in capabilities live here.
 */
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { createAskUserInlineExtension } from "./ask-user-extension";
import { createTodoInlineExtension } from "./todo-extension";
import { createSubagentsInlineExtension } from "./subagents";
import { createPermissionInlineExtension } from "./permission";
import { createMcpInlineExtension } from "./mcp";
import { createJobsNotifyInlineExtension } from "./jobs-notify";

/** All first-party factories registered on every full agent session. */
export function getFirstPartyExtensionFactories(): InlineExtension[] {
  return [
    createTodoInlineExtension(),
    createAskUserInlineExtension(),
    createSubagentsInlineExtension(),
    createPermissionInlineExtension(),
    createMcpInlineExtension(),
    createJobsNotifyInlineExtension(),
  ];
}

export { createTodoInlineExtension } from "./todo-extension";
export { createAskUserInlineExtension } from "./ask-user-extension";
export { createSubagentsInlineExtension } from "./subagents";
export { createPermissionInlineExtension } from "./permission";
export { createMcpInlineExtension } from "./mcp";
export { createJobsNotifyInlineExtension } from "./jobs-notify";
