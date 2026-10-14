// local: JSON-safe Injections tree for the Context panel, built from a captured
// pi-context-view snapshot through its own row model (buildInjectionRows; MIT, Dmitry
// Makarov). Previews follow the TUI item preview: labeled sections under a subheader
// with their token share, marked JSON expanded, extension prompt lines restored in
// place with their (guessed) source.
import { AGGREGATE_SOURCE_ID, type InitialSnapshot, type InjectedReference, type InjectionItem, type JsonSpan } from "./context-view/model";
import { buildInjectionRows, collectItemsById } from "./context-view/ui/injections-model";
import { expandJsonSpan } from "./context-view/ui/json-preview";

export interface LocalInjectionNode {
  id: string;
  kind: "group" | "item";
  label: string;
  tokens: number;
  /** Source group label (for items). */
  source?: string;
  requestOnly?: boolean;
  dropped?: boolean;
  moved?: boolean;
  /** This node counts prompt text attributed to its source by a guess. */
  guessed?: boolean;
  preview: string;
  omittedChars?: number;
  children?: LocalInjectionNode[];
}

export interface LocalContextInjections {
  capturedAt: string;
  origin: "real-turn" | "synthetic-probe";
  /** "captured" = first real request seen in this server run; "static" = computed from session state. */
  source: "captured" | "static";
  totalTokens: number;
  groups: LocalInjectionNode[];
}

export function serializeInjections(
  snapshot: InitialSnapshot,
  previewChars: number,
  source: LocalContextInjections["source"] = "captured",
): LocalContextInjections {
  const items = collectItemsById(snapshot);
  const groups: LocalInjectionNode[] = [];
  let group: LocalInjectionNode | undefined;
  let parent: LocalInjectionNode | undefined;
  let totalTokens = snapshot.totalTokens;
  for (const row of buildInjectionRows(snapshot)) {
    if (row.kind === "group") {
      group = { id: `group:${groups.length}`, kind: "group", label: row.label, tokens: row.tokens, preview: "", children: [] };
      groups.push(group);
      parent = undefined;
    } else if (row.kind === "item" && group) {
      const item = items.get(row.itemId);
      const node: LocalInjectionNode = {
        id: row.itemId,
        kind: "item",
        label: row.label,
        tokens: row.tokens,
        source: group.label,
        ...(item?.requestOnly ? { requestOnly: true } : {}),
        ...(row.dropped ? { dropped: true } : {}),
        ...(row.moved ? { moved: true } : {}),
        ...(item && hasGuess(item) ? { guessed: true } : {}),
        ...truncate(item ? itemPreview(item) : "", previewChars),
      };
      if (row.depth === 1) {
        group.children!.push(node);
        parent = node;
      } else if (parent) {
        (parent.children ??= []).push(node);
      }
    } else if (row.kind === "total") {
      totalTokens = row.tokens;
    }
  }
  for (const g of groups) Object.assign(g, truncate(groupPreview(g), previewChars));
  return {
    capturedAt: snapshot.capturedAt.toISOString(),
    origin: snapshot.origin,
    source,
    totalTokens,
    groups,
  };
}

/** Prompt text counted by an extension was attributed to it by a name/path guess. */
function hasGuess(item: InjectionItem): boolean {
  return item.kind === "prompt-addition" && !item.source.native && item.source.id !== AGGREGATE_SOURCE_ID;
}

function truncate(text: string, max: number): { preview: string; omittedChars?: number } {
  if (text.length <= max) return { preview: text };
  return { preview: text.slice(0, max), omittedChars: text.length - max };
}

function groupPreview(group: LocalInjectionNode): string {
  const lines = (group.children ?? []).map((child) => {
    const subs = (child.children ?? []).map((sub) => `    ${sub.label} · ${fmt(sub.tokens)}`);
    return [`${child.label} · ${fmt(child.tokens)}${child.requestOnly ? " (request-only)" : ""}`, ...subs].join("\n");
  });
  return [`${group.label} · ${fmt(group.tokens)}`, "", ...lines].join("\n");
}

function fmt(tokens: number): string {
  return `${tokens.toLocaleString("en-US")} tokens`;
}

/** Plain-text rendering of pi-context-view's item preview (ui/section-preview.ts previewBodyLines). */
export function itemPreview(item: InjectionItem): string {
  const sections = item.sections ?? [];
  if (sections.length === 0) return body(item.text, item.jsonSpan, item.injectedReferences);
  return sections.map((section) => {
    const marker = section.dropped ? " [dropped]" : section.moved ? " [moved]" : "";
    return `── ${section.label} · ${fmt(section.tokens)}${marker}\n${body(section.text, section.jsonSpan, section.injectedReferences)}`;
  }).join("\n\n");
}

function body(text: string, jsonSpan: JsonSpan | undefined, references: readonly InjectedReference[] | undefined): string {
  if (!references?.length) {
    const trimmed = text.replace(/^\n+/, "");
    const shift = text.length - trimmed.length;
    const span = jsonSpan && shift <= jsonSpan.start ? { start: jsonSpan.start - shift, end: jsonSpan.end - shift } : undefined;
    return expandJsonSpan(trimmed, span).trimEnd();
  }
  let out = "";
  let offset = 0;
  for (const reference of references) {
    out += text.slice(offset, reference.offset);
    const line = out.length === 0 ? reference.text.replace(/^\n+/, "") : reference.text;
    const tool = reference.tool ? `:${reference.tool}` : "";
    out += `${line}  <- ${reference.source.label}${tool}${reference.attribution === "guess" ? " (guess)" : ""}`;
    offset = reference.offset;
  }
  out += text.slice(offset);
  return out.replace(/^\n+/, "").trimEnd();
}
