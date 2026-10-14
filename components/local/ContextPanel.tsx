"use client";

// local: "Context" top-bar panel. A web rendering of the Usage view from the
// pi-context-view extension (MIT, Dmitry Makarov): what occupies the model context,
// as a proportional cell map plus a category legend with per-entry previews.
// Data comes from the read-only `local_context_usage` agent command (lib/local/context-usage.ts).
// The Injections tab lives in ContextInjections.tsx.

import { useCallback, useEffect, useMemo, useState } from "react";
import { sendAgentCommand } from "@/lib/agent-client";
import type {
  LocalContextUsageCategory,
  LocalContextUsageEntry,
  LocalContextUsageResult,
} from "@/lib/local/context-usage";
import type { ContextUsageSnapshot } from "@/lib/local/context-view/model";
import { buildUsageMap, calculateFitMapScale } from "@/lib/local/context-view/ui/usage-map";
import { ContextInjections } from "./ContextInjections";

const MAP_COLUMNS = 16;
const MAP_ROWS = 16;
const BUFFER_ID = "local:buffer";
const FREE_ID = "local:free";

/** Mid-tone hues that keep contrast on both light and dark panels. */
const CATEGORY_COLORS: Record<string, string> = {
  "system-prompt": "#6366f1",
  "context-files": "#0ea5e9",
  "skills": "#14b8a6",
  "built-in-tools": "#8b5cf6",
  "custom-tools": "#d946ef",
  "mcp-tools": "#84cc16",
  "user-messages": "#22c55e",
  "assistant-messages": "#3b82f6",
  "assistant-thinking": "#f59e0b",
  "tool-calls": "#f97316",
  "tool-output": "#f43f5e",
  "extensions": "#b45309",
  "compacted-data": "#64748b",
};
const FALLBACK_COLOR = "#94a3b8";

function categoryColor(id: string | undefined): string {
  return (id && CATEGORY_COLORS[id]) || FALLBACK_COLOR;
}

function formatTokens(tokens: number): string {
  const value = Math.max(0, Math.round(tokens));
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return String(value);
}

function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) return "";
  const percent = fraction * 100;
  if (percent > 0 && percent < 0.1) return "<0.1%";
  return `${percent.toFixed(percent >= 10 ? 0 : 1)}%`;
}

function formatTime(timestamp: number | undefined): string {
  if (timestamp === undefined) return "";
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

interface LegendRow {
  id: string;
  label: string;
  tokens: number;
  color: string;
  depth: number;
  kind: "category" | "buffer" | "free";
  category?: LocalContextUsageCategory;
}

/** Flatten entries across a category's breakdown, chronologically when all are timestamped (as upstream). */
function collectEntries(category: LocalContextUsageCategory): LocalContextUsageEntry[] {
  const entries: LocalContextUsageEntry[] = [];
  const visit = (node: LocalContextUsageCategory) => {
    entries.push(...(node.entries ?? []));
    for (const child of node.children ?? []) visit(child);
  };
  visit(category);
  if (entries.length > 1 && entries.every((entry) => entry.timestamp !== undefined)) {
    entries.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  }
  return entries;
}

function bufferTokens(usage: LocalContextUsageResult): number {
  const contextWindow = usage.reported?.contextWindow;
  const reserve = usage.autoCompactReserveTokens;
  if (!contextWindow || contextWindow <= 0 || reserve === undefined) return 0;
  return Math.min(reserve, Math.max(0, contextWindow - usage.estimatedTokens));
}

function buildLegendRows(usage: LocalContextUsageResult): LegendRow[] {
  const rows: LegendRow[] = [];
  for (const category of usage.categories) {
    const color = categoryColor(category.id);
    rows.push({ id: category.id, label: category.label, tokens: category.tokens, color, depth: 0, kind: "category", category });
    // Like the TUI legend, only Tool Output lists its per-tool children inline.
    if (category.id !== "tool-output") continue;
    for (const child of category.children ?? []) {
      rows.push({ id: child.id, label: child.label, tokens: child.tokens, color, depth: 1, kind: "category", category: child });
    }
  }
  const contextWindow = usage.reported?.contextWindow;
  const buffer = bufferTokens(usage);
  if (buffer > 0) rows.push({ id: BUFFER_ID, label: "Auto-Compact Buffer", tokens: buffer, color: "", depth: 0, kind: "buffer" });
  if (contextWindow && contextWindow > 0) {
    const free = Math.max(0, contextWindow - usage.estimatedTokens - buffer);
    rows.push({ id: FREE_ID, label: "Free Space", tokens: free, color: "", depth: 0, kind: "free" });
  }
  return rows;
}

/** buildUsageMap only reads categories, reported and the reserve; adapt the JSON result to its input type. */
function toSnapshot(usage: LocalContextUsageResult): ContextUsageSnapshot {
  return {
    computedAt: new Date(usage.computedAt),
    modelLabel: usage.modelLabel,
    reported: usage.reported,
    categories: usage.categories.map(({ id, label, tokens }) => ({ id, label, tokens })),
    estimatedTokens: usage.estimatedTokens,
    autoCompactReserveTokens: usage.autoCompactReserveTokens,
  };
}

interface Props {
  sessionId: string | null;
}

export function ContextPanel({ sessionId }: Props) {
  const [usage, setUsage] = useState<LocalContextUsageResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState<"window" | "fit">("window");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [entryIndex, setEntryIndex] = useState(0);
  const [tab, setTab] = useState<"usage" | "injections">("usage");

  const load = useCallback(async (id: string, isCurrent: () => boolean = () => true) => {
    setLoading(true);
    setError(null);
    try {
      const result = await sendAgentCommand<LocalContextUsageResult>(id, { type: "local_context_usage" });
      if (isCurrent()) setUsage(result);
    } catch (loadError) {
      if (isCurrent()) setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setUsage(null);
    setSelectedId(null);
    if (!sessionId) return;
    let current = true;
    void load(sessionId, () => current);
    return () => { current = false; };
  }, [sessionId, load]);

  const snapshot = useMemo(() => (usage ? toSnapshot(usage) : null), [usage]);
  const fitScale = useMemo(() => (snapshot ? calculateFitMapScale(snapshot) : undefined), [snapshot]);
  const contextWindow = usage?.reported?.contextWindow;
  const fitAvailable = fitScale !== undefined && contextWindow !== undefined && fitScale < contextWindow;
  const activeScale = scale === "fit" && fitAvailable ? "fit" : "window";
  const map = useMemo(() => (
    snapshot ? buildUsageMap(snapshot, MAP_COLUMNS, MAP_ROWS, activeScale === "fit" ? fitScale : undefined) : undefined
  ), [snapshot, activeScale, fitScale]);
  const legendRows = useMemo(() => (usage ? buildLegendRows(usage) : []), [usage]);
  const selectedRow = legendRows.find((row) => row.id === selectedId && row.category);
  const entries = useMemo(() => (selectedRow?.category ? collectEntries(selectedRow.category) : []), [selectedRow]);
  const selectedEntry = entries[Math.min(entryIndex, Math.max(0, entries.length - 1))];
  const labelById = useMemo(() => new Map(legendRows.map((row) => [row.id, row.label])), [legendRows]);

  const selectCategory = (id: string) => {
    setSelectedId((current) => (current === id ? null : id));
    setEntryIndex(0);
  };

  const percentOfWindow = (tokens: number) => (contextWindow ? formatPercent(tokens / contextWindow) : "");

  return (
    <section className="local-ctx" aria-label="Context usage">
      <header className="local-ctx-header">
        <span className="local-ctx-title">Context</span>
        <div className="local-ctx-tabs" role="tablist" aria-label="Context view">
          <button type="button" role="tab" aria-selected={tab === "usage"} onClick={() => setTab("usage")}>Usage</button>
          <button type="button" role="tab" aria-selected={tab === "injections"} onClick={() => setTab("injections")}>Injections</button>
        </div>
        {usage && tab === "usage" && (
          <>
            {usage.modelLabel && <span className="local-ctx-model">{usage.modelLabel}</span>}
            <span className="local-ctx-stat" title="Tokens pi reports for the last request (provider usage)">
              {usage.reported?.tokens !== undefined && contextWindow
                ? <>Reported <b>{formatTokens(usage.reported.tokens)}</b> / {formatTokens(contextWindow)} ({formatPercent(usage.reported.tokens / contextWindow)})</>
                : contextWindow
                  ? <>Reported — / {formatTokens(contextWindow)}</>
                  : <>Context window unknown</>}
            </span>
            <span className="local-ctx-stat" title="Sum of the category estimates below (chars/4 heuristic)">
              Estimated <b>≈{formatTokens(usage.estimatedTokens)}</b>{contextWindow ? ` (${formatPercent(usage.estimatedTokens / contextWindow)})` : ""}
            </span>
          </>
        )}
        {usage && tab === "injections" && usage.injections && (
          <span className="local-ctx-stat" title="Estimated tokens of everything injected into the first observed request">
            {usage.injections.source === "static"
              ? <>Static <b>≈{formatTokens(usage.injections.totalTokens)}</b> · from session state</>
              : <>Initial <b>≈{formatTokens(usage.injections.totalTokens)}</b> · captured {formatTime(Date.parse(usage.injections.capturedAt))}</>}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {tab === "usage" && fitAvailable && (
          <div className="local-ctx-toggle" role="group" aria-label="Map scale">
            <button type="button" aria-pressed={activeScale === "window"} onClick={() => setScale("window")}
              title="Map the whole context window">Window</button>
            <button type="button" aria-pressed={activeScale === "fit"} onClick={() => setScale("fit")}
              title={`Zoom ${formatTokens(contextWindow!)} → ${formatTokens(fitScale!)} (estimate + 15%)`}>Fit</button>
          </div>
        )}
        <button
          type="button"
          className="local-ctx-button"
          onClick={() => sessionId && void load(sessionId)}
          disabled={!sessionId || loading}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </header>

      {!sessionId ? (
        <div className="local-ctx-empty">Open a session to see its context usage.</div>
      ) : error ? (
        <div className="local-ctx-empty local-ctx-error">Could not compute context usage: {error}</div>
      ) : !usage ? (
        <div className="local-ctx-empty">Measuring context…</div>
      ) : tab === "injections" ? (
        <ContextInjections injections={usage.injections} reason={usage.injectionsReason} notes={usage.injectionsNotes} />
      ) : (
        <div className="local-ctx-body">
          <div className="local-ctx-map-col">
            {map ? (
              <>
                <div
                  className="local-ctx-map"
                  style={{ gridTemplateColumns: `repeat(${map.columns}, 1fr)` }}
                  role="img"
                  aria-label="Context map"
                >
                  {map.cells.map((cell, index) => {
                    const isCategory = cell.fill === "full" || cell.fill === "partial";
                    const selected = isCategory && selectedId !== null && (
                      cell.categoryId === selectedId
                      || (selectedRow?.depth === 1 && cell.categoryId === "tool-output")
                    );
                    return (
                      <span
                        key={index}
                        className={`local-ctx-cell local-ctx-cell-${cell.fill}${selected ? " is-selected" : ""}`}
                        style={isCategory ? { background: categoryColor(cell.categoryId) } : undefined}
                        title={isCategory
                          ? labelById.get(cell.categoryId ?? "") ?? ""
                          : cell.fill === "buffer" ? "Auto-Compact Buffer" : "Free Space"}
                        onClick={isCategory && cell.categoryId ? () => selectCategory(cell.categoryId!) : undefined}
                      />
                    );
                  })}
                </div>
                <div className="local-ctx-key">
                  <span><span className="local-ctx-cell local-ctx-cell-full local-ctx-key-swatch" /> one cell ≈ {formatTokens(map.blockTokens)} ({formatPercent(1 / (map.columns * map.rows))}{activeScale === "fit" ? " of zoomed scale" : ""})</span>
                  <span><span className="local-ctx-cell local-ctx-cell-partial local-ctx-key-swatch" /> partial cell</span>
                </div>
              </>
            ) : (
              <div className="local-ctx-empty">No context window reported for this model, so no map.</div>
            )}
            <div className="local-ctx-notes">
              {usage.notes.map((note) => <div key={note}>{note}</div>)}
              <div>Estimates use a chars/4 heuristic; reported tokens come from the last response. Computed {formatTime(Date.parse(usage.computedAt))}.</div>
            </div>
          </div>

          <div className="local-ctx-legend" role="list">
            {legendRows.map((row) => {
              const selectable = row.kind === "category";
              const selected = row.id === selectedId;
              return (
                <button
                  key={row.id}
                  type="button"
                  role="listitem"
                  className={`local-ctx-row${selected ? " is-selected" : ""}`}
                  style={{ paddingLeft: 8 + row.depth * 18 }}
                  disabled={!selectable}
                  onClick={selectable ? () => selectCategory(row.id) : undefined}
                >
                  <span
                    className={`local-ctx-swatch${row.kind === "buffer" ? " local-ctx-cell-buffer" : row.kind === "free" ? " local-ctx-cell-free" : ""}${row.depth ? " is-child" : ""}`}
                    style={row.kind === "category" ? { background: row.color } : undefined}
                  />
                  <span className={`local-ctx-row-label${row.depth ? " is-child" : ""}`}>{row.label}</span>
                  <span className="local-ctx-leader" />
                  <span className="local-ctx-row-tokens">{formatTokens(row.tokens)}</span>
                  <span className="local-ctx-row-percent">{percentOfWindow(row.tokens)}</span>
                </button>
              );
            })}
          </div>

          <div className="local-ctx-detail">
            {!selectedRow ? (
              <div className="local-ctx-empty">Select a category to see what it contains.</div>
            ) : (
              <>
                <div className="local-ctx-detail-head">
                  <span className="local-ctx-swatch" style={{ background: selectedRow.color }} />
                  <b>{selectedRow.label}</b>
                  <span className="local-ctx-dim">{formatTokens(selectedRow.tokens)} · {entries.length} {entries.length === 1 ? "entry" : "entries"}</span>
                </div>
                <div className="local-ctx-entries">
                  {entries.map((entry, index) => (
                    <button
                      key={index}
                      type="button"
                      className={`local-ctx-entry${entry === selectedEntry ? " is-selected" : ""}`}
                      onClick={() => setEntryIndex(index)}
                    >
                      <span className="local-ctx-entry-label">
                        {entry.label}
                        {entry.detail && <span className="local-ctx-entry-detail" title={entry.detail}>{entry.detail}</span>}
                      </span>
                      <span className="local-ctx-dim">{formatTime(entry.timestamp)}</span>
                      <span className="local-ctx-row-tokens">{formatTokens(entry.tokens)}</span>
                    </button>
                  ))}
                </div>
                <pre className="local-ctx-preview">
                  {selectedEntry
                    ? previewText(selectedEntry)
                    : ""}
                </pre>
              </>
            )}
          </div>
        </div>
      )}

      <style>{`
        .local-ctx {
          display: flex;
          flex-direction: column;
          height: min(600px, 75dvh);
          min-height: 260px;
          background: var(--bg-panel);
          border-bottom: 1px solid var(--border);
          box-shadow: 0 10px 28px rgba(0,0,0,0.10);
          color: var(--text);
          font-size: 12px;
        }
        .local-ctx-header {
          display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
          padding: 8px 16px;
          border-bottom: 1px solid var(--border);
        }
        .local-ctx-title { font-weight: 600; font-size: 13px; }
        .local-ctx-model {
          font-family: var(--font-mono); font-size: 11px; color: var(--text-muted);
          padding: 1px 6px; border: 1px solid var(--border); border-radius: 4px;
        }
        .local-ctx-stat { color: var(--text-muted); }
        .local-ctx-stat b { color: var(--text); font-weight: 600; }
        .local-ctx-button, .local-ctx-toggle button {
          font-size: 11px; padding: 3px 10px; cursor: pointer;
          background: var(--bg); color: var(--text-muted);
          border: 1px solid var(--border); border-radius: 5px;
        }
        .local-ctx-button:hover:not(:disabled), .local-ctx-toggle button:hover { color: var(--text); background: var(--bg-hover); }
        .local-ctx-button:disabled { opacity: 0.55; cursor: default; }
        .local-ctx-toggle { display: inline-flex; }
        .local-ctx-toggle button { border-radius: 0; }
        .local-ctx-toggle button:first-child { border-radius: 5px 0 0 5px; }
        .local-ctx-toggle button:last-child { border-radius: 0 5px 5px 0; border-left: none; }
        .local-ctx-toggle button[aria-pressed="true"] { background: var(--bg-selected); color: var(--text); }
        .local-ctx-body {
          display: flex; flex: 1; min-height: 0; gap: 0;
          overflow: auto;
        }
        .local-ctx-map-col {
          flex: 0 0 auto; width: 300px; padding: 12px 16px;
          display: flex; flex-direction: column; gap: 10px;
          border-right: 1px solid var(--border);
          overflow-y: auto;
        }
        .local-ctx-map { display: grid; gap: 2px; width: 268px; }
        .local-ctx-cell { display: inline-block; aspect-ratio: 1; border-radius: 2px; }
        .local-ctx-map .local-ctx-cell { cursor: default; }
        .local-ctx-cell-full, .local-ctx-cell-partial { cursor: pointer !important; }
        .local-ctx-cell-partial { opacity: 0.5; }
        .local-ctx-cell.is-selected { outline: 1.5px solid var(--text); outline-offset: -1px; }
        .local-ctx-cell-free { background: var(--bg-hover); box-shadow: inset 0 0 0 1px var(--border); }
        .local-ctx-cell-buffer {
          background: repeating-linear-gradient(135deg, var(--text-dim) 0 1.5px, transparent 1.5px 4px);
          opacity: 0.55;
          box-shadow: inset 0 0 0 1px var(--border);
        }
        .local-ctx-key { display: flex; flex-direction: column; gap: 4px; color: var(--text-muted); font-size: 11px; }
        .local-ctx-key > span { display: flex; align-items: center; gap: 6px; }
        .local-ctx-key-swatch { width: 10px; background: var(--text-muted); }
        .local-ctx-notes { color: var(--text-dim); font-size: 11px; line-height: 1.5; display: flex; flex-direction: column; gap: 4px; }
        .local-ctx-legend {
          flex: 0 0 auto; width: 340px; padding: 8px 0;
          overflow-y: auto;
          border-right: 1px solid var(--border);
        }
        .local-ctx-row {
          display: flex; align-items: center; gap: 8px; width: 100%;
          padding: 4px 12px 4px 8px; min-height: 26px;
          background: none; border: none; border-left: 2px solid transparent;
          color: var(--text); font-size: 12px; text-align: left; cursor: pointer;
        }
        .local-ctx-row:hover:not(:disabled) { background: var(--bg-hover); }
        .local-ctx-row:disabled { cursor: default; color: var(--text-muted); }
        .local-ctx-row.is-selected { background: var(--bg-selected); border-left-color: var(--accent); }
        .local-ctx-swatch { flex: 0 0 auto; width: 11px; height: 11px; border-radius: 3px; display: inline-block; }
        .local-ctx-swatch.is-child { width: 8px; height: 8px; opacity: 0.75; }
        .local-ctx-row-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
        .local-ctx-row-label.is-child { color: var(--text-muted); }
        .local-ctx-leader { flex: 1; min-width: 12px; border-bottom: 1px dotted var(--border); margin: 0 2px; transform: translateY(3px); }
        .local-ctx-row-tokens { font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); text-align: right; min-width: 44px; }
        .local-ctx-row-percent { font-family: var(--font-mono); font-size: 11px; color: var(--text-dim); text-align: right; min-width: 44px; }
        .local-ctx-detail { flex: 1 1 360px; min-width: 320px; display: flex; flex-direction: column; min-height: 0; }
        .local-ctx-detail-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px 6px; }
        .local-ctx-dim { color: var(--text-dim); font-size: 11px; }
        .local-ctx-entries {
          flex: 0 1 auto; max-height: 38%; overflow-y: auto;
          border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);
        }
        .local-ctx-entry {
          display: flex; align-items: center; gap: 10px; width: 100%;
          padding: 3px 14px; background: none; border: none; border-left: 2px solid transparent;
          color: var(--text-muted); font-size: 12px; text-align: left; cursor: pointer;
        }
        .local-ctx-entry:hover { background: var(--bg-hover); color: var(--text); }
        .local-ctx-entry.is-selected { background: var(--bg-selected); color: var(--text); border-left-color: var(--accent); }
        .local-ctx-entry-label { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .local-ctx-entry-detail { margin-left: 8px; font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); }
        .local-ctx-preview {
          flex: 1; min-height: 80px; margin: 0; overflow: auto;
          padding: 10px 14px;
          background: var(--bg);
          color: var(--text-muted);
          font-family: var(--font-mono); font-size: 11.5px; line-height: 1.55;
          white-space: pre-wrap; overflow-wrap: anywhere;
        }
        .local-ctx-tabs { display: inline-flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
        .local-ctx-tabs button {
          font-size: 11.5px; padding: 3px 12px; cursor: pointer;
          background: var(--bg); color: var(--text-muted); border: none;
        }
        .local-ctx-tabs button + button { border-left: 1px solid var(--border); }
        .local-ctx-tabs button:hover { color: var(--text); background: var(--bg-hover); }
        .local-ctx-tabs button[aria-selected="true"] { background: var(--bg-selected); color: var(--text); font-weight: 600; }
        .local-ctx-tree-col {
          flex: 0 0 auto; width: 460px; display: flex; flex-direction: column; min-height: 0;
          border-right: 1px solid var(--border);
        }
        .local-ctx-tree { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 6px 0; }
        .local-ctx-tree-row { gap: 6px; }
        .local-ctx-tree-row.is-group .local-ctx-row-label { font-weight: 600; }
        .local-ctx-chevron {
          flex: 0 0 auto; width: 16px; height: 16px; padding: 0; display: inline-flex; align-items: center; justify-content: center;
          background: none; border: none; border-radius: 3px; color: var(--text-dim); cursor: pointer;
        }
        .local-ctx-chevron:hover { color: var(--text); background: var(--bg-hover); }
        .local-ctx-chevron svg { transition: transform 0.1s; }
        .local-ctx-badge {
          flex: 0 0 auto; font-size: 10px; line-height: 14px; padding: 0 5px; border-radius: 3px;
          color: var(--text-muted); border: 1px solid var(--border); background: var(--bg);
        }
        .local-ctx-total { cursor: default; border-top: 1px solid var(--border); padding: 6px 12px 6px 28px; }
        .local-ctx-total:hover { background: none !important; }
        .local-ctx-tree-notes { padding: 8px 14px 10px; border-top: 1px solid var(--border); }
        .local-ctx-tree-notes summary { cursor: pointer; color: var(--text-muted); }
        .local-ctx-tree-notes details > div { margin-top: 4px; }
        .local-ctx-preview-bordered { border-top: 1px solid var(--border); }
        .local-ctx-empty { padding: 14px 16px; color: var(--text-muted); font-style: italic; }
        .local-ctx-error { color: #e5484d; font-style: normal; }
        @media (max-width: 900px) {
          .local-ctx { height: min(760px, 85dvh); }
          .local-ctx-body { flex-direction: column; }
          .local-ctx-map-col, .local-ctx-legend, .local-ctx-tree-col { width: auto; border-right: none; border-bottom: 1px solid var(--border); overflow: visible; }
          .local-ctx-detail { min-height: 320px; }
        }
      `}</style>
    </section>
  );
}

function previewText(entry: LocalContextUsageEntry): string {
  const parts: string[] = [];
  if (entry.invisibleReasoning) {
    parts.push(entry.invisibleReasoning.basis === "provider-reported"
      ? `[includes ${formatTokens(entry.invisibleReasoning.tokens)} provider-reported reasoning tokens not visible as text]`
      : `[encrypted reasoning signature ≈ ${formatTokens(entry.invisibleReasoning.tokens)} tokens (rough proxy, not counted)]`);
  }
  if (entry.detail) parts.push(`▸ ${entry.detail}\n`);
  parts.push(entry.text === "" ? "(no visible text)" : entry.text);
  if (entry.omittedChars) parts.push(`\n… ${entry.omittedChars.toLocaleString()} more characters not shown`);
  return parts.join("\n");
}

interface ButtonProps {
  active: boolean;
  mobile: boolean;
  disabled: boolean;
  size: number;
  onClick: () => void;
}

/** Top-bar toggle styled like the upstream System/Tools buttons. */
export function ContextPanelButton({ active, mobile, disabled, size, onClick }: ButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title="Context usage"
      aria-label="Context usage"
      aria-pressed={active}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
        width: mobile ? size : undefined,
        height: "100%", padding: mobile ? 0 : "0 12px",
        background: active ? "var(--bg-selected)" : "none",
        border: "none",
        borderTop: active ? "2px solid var(--accent)" : "2px solid transparent",
        borderRight: "1px solid var(--border)",
        cursor: disabled ? "not-allowed" : "pointer",
        color: active ? "var(--text)" : "var(--text-muted)",
        opacity: disabled ? 0.45 : 1,
        fontSize: 11, whiteSpace: "nowrap", transition: "color 0.1s, background 0.1s",
      }}
      onMouseEnter={(event) => {
        if (disabled) return;
        event.currentTarget.style.color = "var(--text)";
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.color = active ? "var(--text)" : "var(--text-muted)";
      }}
      data-mobile-toolbar-action={mobile ? "context" : undefined}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-dim)", flexShrink: 0 }} aria-hidden="true">
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" strokeDasharray="2 2" />
      </svg>
      {!mobile && <span>Context</span>}
    </button>
  );
}
