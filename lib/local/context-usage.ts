// local: server side of the Context panel. Assembles the same inputs pi-context-view's
// `/context` command uses (see lib/local/context-view/, MIT, Dmitry Makarov) from the live
// in-process AgentSession and returns a JSON-safe usage breakdown. Read-only: nothing is
// written to the session, and no model request is made (no silent probe).
import {
  type BuildSystemPromptOptions,
  type SlashCommandInfo,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import {
  buildNativeSnapshot,
  buildUsageSnapshot,
  collectPromptSources,
} from "./context-view/capture";
import { branchMessages, readLocalContextCapture } from "./context-capture";
import { type LocalContextInjections, serializeInjections } from "./context-injections";
import { resolveAutoCompactReserveTokens } from "./context-view/settings";
import { computeUsage, toReportedUsage } from "./context-view/usage";
import type { UsageCategory, UsagePreviewEntry } from "./context-view/model";
import type { AgentSessionLike } from "../pi-types";

export { createLocalContextCaptureExtension } from "./context-capture";
export type { LocalContextInjections, LocalInjectionNode } from "./context-injections";

/** Characters of preview text sent per entry; the rest is summarized as a count. */
export const LOCAL_CONTEXT_PREVIEW_CHARS = 4000;

export interface LocalContextUsageEntry {
  label: string;
  tokens: number;
  timestamp?: number;
  text: string;
  /** Characters dropped from `text` to keep the payload small. */
  omittedChars?: number;
  /** One-line summary of the tool call behind this entry (bash command, file path, pattern). */
  detail?: string;
  /** Invisible reasoning counted into `tokens` (provider-reported) or estimated from signatures. */
  invisibleReasoning?: { tokens: number; basis: "provider-reported" | "signature-proxy" };
}

export interface LocalContextUsageCategory {
  id: string;
  label: string;
  tokens: number;
  children?: LocalContextUsageCategory[];
  entries?: LocalContextUsageEntry[];
}

export interface LocalContextUsageResult {
  computedAt: string;
  modelLabel?: string;
  reported?: { tokens?: number; contextWindow: number; percent?: number };
  estimatedTokens: number;
  autoCompactReserveTokens?: number;
  categories: LocalContextUsageCategory[];
  notes: string[];
  /** Initial (first observed request) injections snapshot, or null with a reason. */
  injections: LocalContextInjections | null;
  injectionsReason?: string;
  injectionsNotes?: string[];
}

const STATIC_INJECTIONS_NOTES = [
  "Computed from the session's prompt, instruction files, skills and tools; no request observed in this server run yet.",
  "Extension additions made at request time (prompt text appended in before_agent_start, request-only messages) appear after the next message in this session; then Refresh.",
  "Prompt additions are attributed by guessing from package names, paths and registered tool names, as in pi-context-view.",
];
const INJECTIONS_NOTES = [
  "Frozen at the first request pi-web observed for this session in this server run; memory only.",
  "Prompt additions are attributed by guessing from package names, paths and registered tool names, as in pi-context-view.",
  "Edits extensions make to pi's structured prompt options (sections, appended prompt) count as pi's own parts, not as extension additions.",
];

type ContextUsageSession = Pick<
  AgentSessionLike,
  "sessionManager" | "settingsManager" | "model" | "promptTemplates" | "resourceLoader"
  | "getAllTools" | "getActiveToolNames" | "getContextUsage"
> & {
  readonly systemPrompt?: string;
  readonly agent?: { state?: { tools?: ToolInfo[] } };
  readonly extensionRunner: AgentSessionLike["extensionRunner"] & {
    createCommandContext?: () => { getSystemPromptOptions?: () => BuildSystemPromptOptions };
  };
};

export function localContextUsage(session: AgentSessionLike, exactSystemPrompt?: string): LocalContextUsageResult {
  const inner = session as unknown as ContextUsageSession;
  const manager = inner.sessionManager;
  // Keep messages from an earlier pi-context-view silent probe out of the estimate, as /context does.
  const messages = branchMessages(manager, manager.getLeafId());
  const capture = exactSystemPrompt === undefined ? readLocalContextCapture(manager) : undefined;

  // `agent.state.tools` is the final prepared declaration list sent in requests.
  // In Code mode it may rewrite descriptions/parameters or omit declarations;
  // counting getAllTools() would describe tools the model did not receive.
  const options = readSystemPromptOptions(inner);
  const hiddenDeclarations: unknown = Reflect.get(inner, "_hiddenDeclarations");
  const hiddenTools = new Set<string>([
    ...(hiddenDeclarations instanceof Set ? [...hiddenDeclarations].filter((name): name is string => typeof name === "string") : []),
    ...(options.hiddenTools ?? []),
  ]);
  const { allTools, activeToolNames } = contextToolDeclarations(inner, hiddenTools);
  const nativeInput = {
    systemPrompt: exactSystemPrompt ?? inner.systemPrompt ?? "",
    options,
    allTools,
    activeToolNames,
    promptSources: collectPromptSources(allTools, listCommands(inner)),
  };
  // Request-only extension messages come from the latest captured request (see
  // context-capture.ts); before any request, fall back to the native snapshot.
  const snapshot = buildUsageSnapshot({
    ...nativeInput,
    messages,
    initial: capture?.latest ?? buildNativeSnapshot(nativeInput),
  });

  const usage = computeUsage({
    snapshot,
    messages,
    reported: toReportedUsage(inner.getContextUsage()),
    modelLabel: inner.model?.id,
    autoCompactReserveTokens: resolveAutoCompactReserveTokens(inner.settingsManager, inner.model),
  });

  return {
    computedAt: usage.computedAt.toISOString(),
    modelLabel: usage.modelLabel,
    reported: usage.reported ? { ...usage.reported } : undefined,
    estimatedTokens: usage.estimatedTokens,
    autoCompactReserveTokens: usage.autoCompactReserveTokens,
    categories: usage.categories.map((category) => serializeCategory(category, toolDetails(messages))),
    notes: [capture?.latest && capture.latestAt
      ? `Request-only extension messages counted from the latest request (${capture.latestAt.toLocaleTimeString()}).`
      : "Request-only extension injections are not captured yet (no request observed in this server run)."],
    // Before any request, show what can be derived from session state (like the TUI's
    // Initial view minus request-time extension additions); never run a probe.
    injections: capture?.initial
      ? serializeInjections(capture.initial, LOCAL_CONTEXT_PREVIEW_CHARS, "captured")
      : serializeInjections(buildNativeSnapshot(nativeInput), LOCAL_CONTEXT_PREVIEW_CHARS, "static"),
    injectionsNotes: capture?.initial ? INJECTIONS_NOTES : STATIC_INJECTIONS_NOTES,
  };
}

export function contextToolDeclarations(
  inner: Pick<AgentSessionLike, "getAllTools" | "getActiveToolNames"> & { agent?: { state?: { tools?: ToolInfo[] } } },
  hiddenTools: ReadonlySet<string> = new Set(),
): { allTools: ToolInfo[]; activeToolNames: string[] } {
  const declarations = inner.agent?.state?.tools;
  const registeredTools = inner.getAllTools() as unknown as ToolInfo[];
  if (!declarations?.length) {
    const active = new Set(inner.getActiveToolNames());
    const allTools = registeredTools.filter((tool) => active.has(tool.name) && !hiddenTools.has(tool.name));
    return { allTools, activeToolNames: allTools.map((tool) => tool.name) };
  }
  const registeredByName = new Map(registeredTools.map((tool) => [tool.name, tool]));
  const visibleDeclarations = declarations.filter((tool) => !hiddenTools.has(tool.name));
  const allTools = visibleDeclarations.map((declaration) => ({
    ...registeredByName.get(declaration.name),
    ...declaration,
  })) as ToolInfo[];
  return { allTools, activeToolNames: allTools.map((tool) => tool.name) };
}

function readSystemPromptOptions(inner: ContextUsageSession): BuildSystemPromptOptions {
  try {
    const options = inner.extensionRunner.createCommandContext?.().getSystemPromptOptions?.();
    if (options) return options;
  } catch {
    // A stale runner falls back to the bare cwd, like pi's own default.
  }
  return { cwd: inner.sessionManager.getCwd() } as BuildSystemPromptOptions;
}

/** Same command roster the SDK hands extensions through `pi.getCommands()`. */
function listCommands(inner: ContextUsageSession): SlashCommandInfo[] {
  return [
    ...inner.extensionRunner.getRegisteredCommands().map((command) => ({
      name: command.invocationName,
      description: command.description,
      source: "extension" as const,
      sourceInfo: command.sourceInfo,
    })),
    ...inner.promptTemplates.map((template) => ({
      name: template.name,
      description: template.description,
      source: "prompt" as const,
      sourceInfo: template.sourceInfo,
    })),
    ...inner.resourceLoader.getSkills().skills.map((skill) => ({
      name: `skill:${skill.name}`,
      description: skill.description,
      source: "skill" as const,
      sourceInfo: skill.sourceInfo,
    })),
  ] as SlashCommandInfo[];
}

/**
 * Tool details in message order, keyed like the entries' breadcrumbs:
 * "result:<tool>" for Tool Output entries, "call:<tool>" for Tool Calls entries.
 * usage.ts appends entries in the same order it walks these messages.
 */
function toolDetails(messages: readonly unknown[]): Map<string, string[]> {
  const byCallId = new Map<string, string>();
  const queues = new Map<string, string[]>();
  const push = (key: string, detail: string) => {
    const queue = queues.get(key);
    if (queue) queue.push(detail);
    else queues.set(key, [detail]);
  };
  for (const message of messages as { role?: string; content?: unknown; toolName?: string; toolCallId?: string }[]) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content as { type?: string; id?: string; name?: string; arguments?: unknown }[]) {
        if (block.type !== "toolCall" || !block.name) continue;
        const detail = describeToolArgs(block.name, block.arguments);
        if (block.id) byCallId.set(block.id, detail);
        push(`call:${block.name}`, detail);
      }
    } else if (message.role === "toolResult" && message.toolName) {
      push(`result:${message.toolName}`, (message.toolCallId && byCallId.get(message.toolCallId)) || "");
    }
  }
  return queues;
}

const DETAIL_MAX_CHARS = 200;

export function describeToolArgs(toolName: string, args: unknown): string {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const str = (key: string) => (typeof a[key] === "string" ? (a[key] as string) : undefined);
  let detail: string | undefined;
  switch (toolName) {
    case "bash":
      detail = str("command");
      break;
    case "read": {
      const path = str("path");
      const offset = typeof a.offset === "number" ? a.offset : undefined;
      const limit = typeof a.limit === "number" ? a.limit : undefined;
      detail = path && (offset !== undefined || limit !== undefined)
        ? `${path}:${offset ?? 1}${limit !== undefined ? `+${limit}` : ""}`
        : path;
      break;
    }
    case "grep":
    case "find": {
      const pattern = str("pattern");
      const path = str("path");
      detail = pattern ? (path ? `${pattern} in ${path}` : pattern) : path;
      break;
    }
    default:
      detail = str("path") ?? Object.values(a).find((value): value is string => typeof value === "string");
  }
  if (detail === undefined) detail = Object.keys(a).length ? JSON.stringify(a) : "";
  const oneLine = detail.replace(/\s+/g, " ").trim();
  return oneLine.length > DETAIL_MAX_CHARS ? `${oneLine.slice(0, DETAIL_MAX_CHARS - 1)}…` : oneLine;
}

type DetailScope = "tool-output" | "tool-calls" | "bash-executions" | undefined;

function serializeCategory(
  category: UsageCategory,
  details: Map<string, string[]>,
  parentScope?: DetailScope,
): LocalContextUsageCategory {
  const scope: DetailScope = category.id === "tool-calls" || category.id === "bash-executions" || category.id === "tool-output"
    ? category.id
    : parentScope;
  const entries = category.entries?.map((entry) => {
    const serialized = serializeEntry(entry);
    let detail: string | undefined;
    if (scope === "bash-executions") detail = entry.text.split("\n", 1)[0]?.replace(/^\$ /, "");
    else if (scope === "tool-output") detail = details.get(`result:${entry.breadcrumb[0]}`)?.shift();
    else if (scope === "tool-calls") detail = details.get(`call:${entry.breadcrumb[1]}`)?.shift();
    return detail ? { ...serialized, detail } : serialized;
  });
  return {
    id: category.id,
    label: category.label,
    tokens: category.tokens,
    ...(category.children?.length ? { children: category.children.map((child) => serializeCategory(child, details, scope)) } : {}),
    ...(entries?.length ? { entries } : {}),
  };
}

function serializeEntry(entry: UsagePreviewEntry): LocalContextUsageEntry {
  const text = entry.text.length > LOCAL_CONTEXT_PREVIEW_CHARS
    ? entry.text.slice(0, LOCAL_CONTEXT_PREVIEW_CHARS)
    : entry.text;
  return {
    label: entry.breadcrumb.join(" › "),
    tokens: entry.tokens,
    ...(entry.timestamp !== undefined ? { timestamp: entry.timestamp } : {}),
    text,
    ...(text.length < entry.text.length ? { omittedChars: entry.text.length - text.length } : {}),
    ...(entry.invisibleReasoning
      ? { invisibleReasoning: { tokens: entry.invisibleReasoning.tokens, basis: entry.invisibleReasoning.basis } }
      : {}),
  };
}
