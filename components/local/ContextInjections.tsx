"use client";

// local: "Injections" tab of the Context panel. A web rendering of pi-context-view's
// Injections view (MIT, Dmitry Makarov): the Initial snapshot of what pi and its
// extensions injected into the first observed request, grouped by source. Data is the
// `injections` tree of the read-only `local_context_usage` command
// (lib/local/context-injections.ts); styles live in ContextPanel.tsx.

import { type ReactNode, useMemo, useState } from "react";
import type { LocalContextInjections, LocalInjectionNode } from "@/lib/local/context-usage";

function formatTokens(tokens: number): string {
  const value = Math.max(0, Math.round(tokens));
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return String(value);
}

function formatShare(tokens: number, total: number): string {
  if (total <= 0) return "";
  const percent = (tokens / total) * 100;
  if (percent > 0 && percent < 0.1) return "<0.1%";
  return `${percent.toFixed(percent >= 10 ? 0 : 1)}%`;
}

function findNode(groups: LocalInjectionNode[], id: string | null): LocalInjectionNode | undefined {
  if (id === null) return undefined;
  const stack = [...groups];
  while (stack.length) {
    const node = stack.shift()!;
    if (node.id === id) return node;
    stack.push(...(node.children ?? []));
  }
  return undefined;
}

function Badges({ node }: { node: LocalInjectionNode }) {
  return (
    <>
      {node.requestOnly && <span className="local-ctx-badge" title="Only in the outgoing request, not in the session file">request-only</span>}
      {node.guessed && <span className="local-ctx-badge" title="Source guessed from package names, paths and tool names">guess</span>}
      {node.dropped && <span className="local-ctx-badge" title="Dropped by a --system-prompt replacement (0 tokens)">dropped</span>}
      {node.moved && <span className="local-ctx-badge" title="Moved by an extension out of the region pi renders it into">moved</span>}
    </>
  );
}

interface Props {
  injections: LocalContextInjections | null;
  reason?: string;
  notes?: string[];
}

export function ContextInjections({ injections, reason, notes }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Groups start open, items with sub-items start closed (as compact as the TUI list allows).
  const [toggled, setToggled] = useState<Set<string>>(() => new Set());
  const groups = useMemo(() => injections?.groups ?? [], [injections]);
  const selected = findNode(groups, selectedId);

  if (!injections) {
    return <div className="local-ctx-empty">{reason ?? "No injections captured."}</div>;
  }

  const total = injections.totalTokens;
  const isOpen = (node: LocalInjectionNode) => (node.kind === "group") !== toggled.has(node.id);
  const toggle = (id: string) => setToggled((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const renderNode = (node: LocalInjectionNode, depth: number): ReactNode => {
    const hasChildren = (node.children?.length ?? 0) > 0;
    const open = hasChildren && isOpen(node);
    return (
      <div key={node.id} role="treeitem" aria-expanded={hasChildren ? open : undefined} aria-selected={node.id === selectedId}>
        <div
          className={`local-ctx-row local-ctx-tree-row${node.id === selectedId ? " is-selected" : ""}${depth === 0 ? " is-group" : ""}`}
          style={{ paddingLeft: 6 + depth * 16 }}
          onClick={() => setSelectedId(node.id)}
        >
          <button
            type="button"
            className="local-ctx-chevron"
            aria-label={open ? "Collapse" : "Expand"}
            style={{ visibility: hasChildren ? "visible" : "hidden" }}
            onClick={(event) => { event.stopPropagation(); toggle(node.id); }}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" style={{ transform: open ? "rotate(90deg)" : undefined }}>
              <path d="M3 1.5 L7 5 L3 8.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <span className={`local-ctx-row-label${depth > 0 ? " is-child" : ""}`} title={node.label}>{node.label}</span>
          <Badges node={node} />
          <span className="local-ctx-leader" />
          <span className="local-ctx-row-tokens">{formatTokens(node.tokens)}</span>
          <span className="local-ctx-row-percent">{formatShare(node.tokens, total)}</span>
        </div>
        {open && node.children!.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  return (
    <div className="local-ctx-body">
      <div className="local-ctx-tree-col">
        <div className="local-ctx-tree" role="tree" aria-label="Injections by source">
          {groups.map((group) => renderNode(group, 0))}
        </div>
        <div className="local-ctx-row local-ctx-total" aria-label="Total">
          <span className="local-ctx-row-label"><b>TOTAL</b></span>
          <span className="local-ctx-leader" />
          <span className="local-ctx-row-tokens"><b>{formatTokens(total)}</b></span>
          <span className="local-ctx-row-percent" />
        </div>
        <div className="local-ctx-notes local-ctx-tree-notes">
          <div>
            {injections.source === "static"
              ? "Computed from session state, not from a request."
              : <>Captured {new Date(injections.capturedAt).toLocaleString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", day: "numeric", month: "short" })} from a real request.</>}
          </div>
          {notes?.length ? (
            <details>
              <summary>About this snapshot</summary>
              {notes.map((note) => <div key={note}>{note}</div>)}
            </details>
          ) : null}
        </div>
      </div>

      <div className="local-ctx-detail">
        {!selected ? (
          <div className="local-ctx-empty">Select a source or item to preview what it injected.</div>
        ) : (
          <>
            <div className="local-ctx-detail-head">
              <b>{selected.label}</b>
              {selected.source && <span className="local-ctx-model">{selected.source}</span>}
              <Badges node={selected} />
              <span className="local-ctx-dim">
                {selected.tokens.toLocaleString()} tokens · {formatShare(selected.tokens, total)} of TOTAL
              </span>
            </div>
            <pre className="local-ctx-preview local-ctx-preview-bordered">
              {selected.preview === "" ? "(no text)" : selected.preview}
              {selected.omittedChars ? `\n… ${selected.omittedChars.toLocaleString()} more characters not shown` : ""}
            </pre>
          </>
        )}
      </div>
    </div>
  );
}
