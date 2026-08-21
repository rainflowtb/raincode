"use client";

/**
 * Message jump ticks: one small horizontal tick per user/assistant message,
 * floating at the right edge of the chat viewport (the old right rail is gone).
 * Click a tick to jump to that message; hover reveals a single-line preview.
 * The floating scrollbar thumb itself is owned by lib/overlay-scrollbars.ts —
 * this component is only the message-jump layer.
 */

import { useEffect, useRef, useState, useCallback, useMemo, RefObject } from "react";
import type { AgentMessage, AssistantMessage, TextContent } from "@/lib/types";

interface Props {
  messages: AgentMessage[];
  streamingMessage: Partial<AgentMessage> | null;
  scrollContainer: RefObject<HTMLDivElement | null>;
  messageRefs: RefObject<(HTMLDivElement | null)[]>;
}

function getMessagePreview(msg: AgentMessage | Partial<AgentMessage>): string {
  if (msg.role === "user") {
    const content = msg.content;
    if (typeof content === "string") return content.slice(0, 200);
    if (Array.isArray(content)) {
      return (content as { type: string; text?: string }[])
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text!)
        .join("\n")
        .slice(0, 200);
    }
    return "";
  }
  if (msg.role === "assistant") {
    const blocks = (msg as Partial<AssistantMessage>).content ?? [];
    const text = blocks
      .filter((b): b is TextContent => b.type === "text")
      .map((b) => b.text)
      .join(" ");
    if (text) return text.slice(0, 200);
    const toolNames = blocks
      .filter((b) => b.type === "toolCall")
      .map((b) => (b as { type: string; toolName: string }).toolName);
    if (toolNames.length) return toolNames.join(", ");
    return "";
  }
  return "";
}

function hasTextContent(msg: AgentMessage | Partial<AgentMessage>): boolean {
  if (msg.role === "user") return true;
  if (msg.role === "assistant") {
    const blocks = (msg as Partial<AssistantMessage>).content ?? [];
    return blocks.some((b) => b.type === "text");
  }
  return false;
}

interface NodeInfo {
  topRatio: number;   // 0–1 within total scroll height
  preview: string;    // resolved while measuring, never during render
  isUser: boolean;
  index: number;
}

const RATIO_EPSILON = 0.0005;

function sameNodes(prev: NodeInfo[], next: NodeInfo[]): boolean {
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    const a = prev[i];
    const b = next[i];
    if (a.isUser !== b.isUser || a.preview !== b.preview) return false;
    if (Math.abs(a.topRatio - b.topRatio) > RATIO_EPSILON) return false;
  }
  return true;
}

export function ChatMinimap({ messages, streamingMessage, scrollContainer, messageRefs }: Props) {
  const [visible, setVisible] = useState(false);
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRafRef = useRef<number | null>(null);
  const streamingRef = useRef(false);
  streamingRef.current = streamingMessage !== null;

  const allMessages = useMemo(
    () => (streamingMessage ? [...messages, streamingMessage] : messages) as (AgentMessage | Partial<AgentMessage>)[],
    [messages, streamingMessage]
  );
  const allMessagesRef = useRef(allMessages);
  allMessagesRef.current = allMessages;

  // rAF-coalesced overflow check: ticks only exist when the transcript scrolls.
  const updateScroll = useCallback(() => {
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const scrollEl = scrollContainer.current;
      if (!scrollEl) return;
      setVisible(scrollEl.scrollHeight - scrollEl.clientHeight > 20);
    });
  }, [scrollContainer]);

  // Throttled DOM measurement (message tops as ratios of total scroll height).
  const measureThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const measureNodes = useCallback(() => {
    if (measureThrottleRef.current) return;
    measureThrottleRef.current = setTimeout(() => {
      measureThrottleRef.current = null;
      const scrollEl = scrollContainer.current;
      if (!scrollEl) return;
      const totalH = scrollEl.scrollHeight;
      if (totalH <= 0) return;

      const refs = messageRefs.current;
      const newNodes: NodeInfo[] = [];
      let refIndex = 0;
      const all = allMessagesRef.current;
      const containerRect = scrollEl.getBoundingClientRect();

      for (let i = 0; i < all.length; i++) {
        const msg = all[i];
        if (msg.role !== "user" && msg.role !== "assistant") continue;
        const el = refs?.[refIndex];
        refIndex++;
        if (!hasTextContent(msg)) continue;
        if (el) {
          const elRect = el.getBoundingClientRect();
          const top = elRect.top - containerRect.top + scrollEl.scrollTop;
          newNodes.push({
            topRatio: top / totalH,
            preview: getMessagePreview(msg),
            isUser: msg.role === "user",
            index: newNodes.length,
          });
        }
      }
      setNodes((prev) => (sameNodes(prev, newNodes) ? prev : newNodes));
    }, streamingRef.current ? 500 : 150);
  }, [scrollContainer, messageRefs]);

  useEffect(() => {
    const el = scrollContainer.current;
    if (!el) return;
    el.addEventListener("scroll", updateScroll, { passive: true });
    return () => el.removeEventListener("scroll", updateScroll);
  }, [scrollContainer, updateScroll]);

  // Keep tick positions in sync with layout changes.
  useEffect(() => {
    const el = scrollContainer.current;
    if (!el) return;
    const syncLayout = () => {
      updateScroll();
      measureNodes();
    };
    const ro = new ResizeObserver(syncLayout);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    syncLayout();
    return () => {
      ro.disconnect();
      if (measureThrottleRef.current) {
        clearTimeout(measureThrottleRef.current);
        measureThrottleRef.current = null;
      }
    };
  }, [scrollContainer, measureNodes, updateScroll]);

  // Wait briefly for new message DOM before syncing layout.
  useEffect(() => {
    const t = setTimeout(() => {
      updateScroll();
      measureNodes();
    }, 50);
    return () => clearTimeout(t);
  }, [messages.length, measureNodes, updateScroll]);

  useEffect(() => () => {
    if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
  }, []);

  const jumpTo = useCallback((node: NodeInfo) => {
    const el = scrollContainer.current;
    if (!el) return;
    // Documented minimap exception: the jump layer may write scrollTop (the
    // scroll owner itself stays use-stick-to-bottom).
    el.scrollTop = Math.max(0, node.topRatio * el.scrollHeight - 4);
  }, [scrollContainer]);

  if (!visible) return null;

  const hovered = hoveredIndex !== null ? nodes.find((n) => n.index === hoveredIndex) : null;

  return (
    <div
      ref={containerRef}
      className="chat-minimap"
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        userSelect: "none",
      }}
    >
      {nodes.map((node) => {
        const isHovered = hoveredIndex === node.index;
        const baseWidth = node.isUser ? 12 : 8;
        return (
          <button
            key={node.index}
            type="button"
            aria-label={node.preview.slice(0, 40)}
            onClick={() => jumpTo(node)}
            onMouseEnter={() => setHoveredIndex(node.index)}
            onMouseLeave={() => setHoveredIndex((prev) => (prev === node.index ? null : prev))}
            style={{
              position: "absolute",
              top: `${node.topRatio * 100}%`,
              right: 0,
              transform: "translateY(-50%)",
              width: isHovered ? baseWidth + 4 : baseWidth,
              height: 2,
              padding: 0,
              border: "none",
              borderRadius: "var(--radius-pill)",
              background: node.isUser
                ? `color-mix(in oklab, var(--accent) ${isHovered ? 90 : 55}%, transparent)`
                : `color-mix(in oklab, var(--text) ${isHovered ? 50 : 26}%, transparent)`,
              cursor: "pointer",
              pointerEvents: "auto",
              transition: "width 0.1s ease, background 0.1s ease",
            }}
          />
        );
      })}

      {/* Single preview tooltip for the hovered tick (left of the tick). */}
      {hovered && hovered.preview && (
        <div
          style={{
            position: "absolute",
            top: `${hovered.topRatio * 100}%`,
            right: "calc(100% + 6px)",
            transform: "translateY(-50%)",
            maxWidth: 240,
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderLeft: `2px solid ${hovered.isUser ? "var(--accent)" : "var(--text-dim)"}`,
            borderRadius: "var(--radius-xs)",
            padding: "2px 7px",
            fontSize: 11,
            color: "var(--text-muted)",
            lineHeight: 1.4,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            pointerEvents: "none",
            zIndex: 100,
          }}
        >
          {hovered.preview}
        </div>
      )}
    </div>
  );
}

// Hook to create a stable array of refs for messages
export function useMessageRefs(count: number): RefObject<(HTMLDivElement | null)[]> {
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  // Resize in place — rebuilding the array on every parent render is O(n) garbage.
  if (refs.current.length !== count) {
    const previousLength = refs.current.length;
    refs.current.length = count;
    if (count > previousLength) refs.current.fill(null, previousLength);
  }
  return refs;
}
