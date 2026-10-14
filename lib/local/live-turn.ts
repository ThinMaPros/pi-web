// local: layout of the turn that is still running. Upstream shows every step
// of a live turn expanded and only folds them into "Process details" once the
// turn ends; this plans the folded layout for the live turn too: all steps
// (including the streaming message's thinking/tool calls) go into the group,
// and only answer text stays outside, below the group line.

import type { AgentMessage, AssistantMessage } from "@/lib/types";
import { countToolCallBlocks, getDisplayableAssistantBlocks, isHiddenCustomMessage, splitFinalAssistantBlocks } from "@/lib/message-display";

export type LiveTurnItem = { idx: number; override?: AssistantMessage };

export interface LiveTurnPlan {
  /** Messages inside the group, in order. */
  process: LiveTurnItem[];
  /** Answer text of the last committed assistant message, shown outside the group. */
  answer: LiveTurnItem | null;
  /** Messages after the last assistant message that upstream renders outside the group. */
  rest: number[];
  /** Streaming message split: thinking/tool calls go inside, answer text outside. */
  streamProcess: AssistantMessage | null;
  streamAnswer: AssistantMessage | null;
  messageCount: number;
  toolCallCount: number;
}

function withContent(message: AssistantMessage, content: AssistantMessage["content"], omitUsage = false): AssistantMessage {
  const next = { ...message, content };
  if (omitUsage) next.usage = undefined;
  return next;
}

export function planLiveTurn(
  messages: AgentMessage[],
  userIdx: number,
  endIdx: number,
  streaming: AssistantMessage | null,
): LiveTurnPlan {
  let lastAssistantIdx = -1;
  for (let i = endIdx - 1; i > userIdx; i--) {
    if (messages[i]?.role === "assistant") { lastAssistantIdx = i; break; }
  }

  const process: LiveTurnItem[] = [];
  let answer: LiveTurnItem | null = null;
  let messageCount = 0;
  let toolCallCount = 0;
  const processEnd = lastAssistantIdx === -1 ? endIdx - 1 : lastAssistantIdx;
  for (let i = userIdx + 1; i <= processEnd; i++) {
    const message = messages[i];
    if (message.role === "custom") {
      if (isHiddenCustomMessage(message)) continue;
      process.push({ idx: i });
      messageCount += 1;
      continue;
    }
    if (message.role !== "assistant") continue;
    let override: AssistantMessage | undefined;
    if (i === lastAssistantIdx) {
      // Same split as a finished turn: trailing answer text stays outside.
      const split = splitFinalAssistantBlocks(message);
      if (split.answerBlocks.length > 0) {
        const end = message.content.indexOf(split.answerBlocks[0]);
        answer = { idx: i, override: withContent(message, split.answerBlocks) };
        override = withContent(message, message.content.slice(0, end < 0 ? undefined : end), true);
      }
    }
    const blocks = getDisplayableAssistantBlocks(override ?? message);
    if (blocks.length === 0) continue;
    process.push({ idx: i, override });
    messageCount += 1;
    toolCallCount += countToolCallBlocks(blocks);
  }

  const rest: number[] = [];
  for (let i = processEnd + 1; i < endIdx; i++) rest.push(i);

  let streamProcess: AssistantMessage | null = null;
  let streamAnswer: AssistantMessage | null = null;
  if (streaming) {
    const split = splitFinalAssistantBlocks(streaming);
    if (split.processBlocks.length > 0) {
      streamProcess = withContent(streaming, split.processBlocks);
      messageCount += 1;
      toolCallCount += countToolCallBlocks(split.processBlocks);
    }
    if (split.answerBlocks.length > 0) streamAnswer = withContent(streaming, split.answerBlocks);
  }

  return { process, answer, rest, streamProcess, streamAnswer, messageCount, toolCallCount };
}
