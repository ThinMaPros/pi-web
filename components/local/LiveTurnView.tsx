"use client";

import { useLayoutEffect, useMemo, useState } from "react";
import { MessageView } from "@/components/MessageView";
import type { AssistantMessage, ToolResultMessage } from "@/lib/types";
import { countToolCallBlocks } from "@/lib/message-display";
import { splitFinalAssistantBlocks } from "@/lib/message-display";
import type { StreamingStore } from "@/lib/streaming-message";
import { selectStreamingMessage, useStreamingSelector } from "@/hooks/useStreamingSelector";

export function LiveTurnView({ store, onCommit, t, children, answer, messageCount, toolCallCount, toolResults, modelNames, cwd, onOpenFile, onOpenSubagent }: {
  store: StreamingStore;
  onCommit: () => void;
  t: (key: string, params?: Record<string, string | number>) => string;
  children: React.ReactNode;
  answer?: React.ReactNode;
  messageCount: number;
  toolCallCount: number;
  toolResults: Map<string, ToolResultMessage>;
  modelNames: Record<string, string>;
  cwd?: string;
  onOpenFile?: (filePath: string, page?: number) => void;
  onOpenSubagent?: (sessionId: string, label: string) => void;
}) {
  const streaming = useStreamingSelector(store, selectStreamingMessage);
  useLayoutEffect(onCommit, [streaming, onCommit]);
  const [expanded, setExpanded] = useState(false);
  const split = useMemo(() => streaming ? splitFinalAssistantBlocks(streaming as AssistantMessage) : null, [streaming]);
  const streamProcess = split?.processBlocks.length ? { ...streaming!, content: split.processBlocks } as AssistantMessage : null;
  const streamAnswer = split?.answerBlocks.length ? { ...streaming!, content: split.answerBlocks } as AssistantMessage : null;
  const totalMessages = messageCount + (streamProcess ? 1 : 0);
  const totalTools = toolCallCount + (streamProcess ? countToolCallBlocks(streamProcess.content) : 0);
  const parts = ["Processing", `${totalMessages} ${t(totalMessages === 1 ? "chat.message" : "chat.messages")}`];
  if (totalTools) parts.push(`${totalTools} ${t(totalTools === 1 ? "chat.toolCall" : "chat.toolCalls")}`);

  return <>
    {(totalMessages > 0) && <div style={{ marginBottom: 14 }}>
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)} style={{ display: "flex", alignItems: "center", gap: 8, width: "auto", minHeight: 24, padding: "2px 0", border: "none", background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 12, textAlign: "left" }}>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}><polyline points="4 2.5 7.5 6 4 9.5" /></svg>
        <span>{parts.join(" · ")}</span>
      </button>
      {expanded && <div style={{ marginTop: 8 }}>{children}{streamProcess && <MessageView message={streamProcess} toolResults={toolResults} isStreaming modelNames={modelNames} cwd={cwd} onOpenFile={onOpenFile} onOpenSubagent={onOpenSubagent} />}</div>}
    </div>}
    {answer}
    {streamAnswer && <MessageView message={streamAnswer} toolResults={toolResults} isStreaming modelNames={modelNames} cwd={cwd} onOpenFile={onOpenFile} onOpenSubagent={onOpenSubagent} />}
  </>;
}
