/**
 * Native RainCode subagent records — one owner for spawn state.
 */

export const SUBAGENT_TOOL_NAMES = [
  "subagent",
  "subagent_fork",
  "get_subagent_result",
  "steer_subagent",
  "send_message",
  "list_agents",
  "interrupt_agent",
  "kill_subagent",
] as const;

export const READ_ONLY_TOOLS = ["read", "bash", "grep", "find", "ls"] as const;
export const FULL_CODING_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

export type SubagentStatus =
  | "queued"
  | "running"
  | "completed"
  | "error"
  | "stopped"
  | "aborted";

export type AgentTypeConfig = {
  name: string;
  displayName: string;
  description: string;
  tools: string[];
  systemPrompt: string;
  promptMode: "replace" | "append";
  model?: string;
  thinking?: string;
  maxTurns?: number;
  enabled: boolean;
  /** Replace-mode only: append project context files (AGENTS.md set) to the prompt. */
  injectAgentsMd?: boolean;
  /** Settings-UI tag color (visual identity only; unused at spawn time). */
  color?: string;
};

export type SubagentRecord = {
  id: string;
  type: string;
  displayName: string;
  description: string;
  status: SubagentStatus;
  result?: string;
  error?: string;
  activity?: string;
  contextPercent?: number;
  contextTokens?: number;
  startedAt: number;
  completedAt?: number;
  note?: string;
  sessionId?: string;
  sessionFile?: string;
  mode?: "continuable" | "one-shot";
  depth?: number;
  parentSessionId?: string;
  /** Wall-clock ms of the parent turn that spawned this agent (captured at idle-input beginPrompt, steer-robust). */
  parentTurnStartedAt?: number;
  summary?: string;
};
