"use client";

// local: controls in the composer's bottom row.
//   ContextMeter  context window usage next to the account button (green/yellow/red),
//                 plus the last response's tokens like pi-droid-styling: ↑in ↓out R cache-read CH cache-hit%
//   ToolsButton   replaces upstream's tool preset picker; opens the /tools or /defer menus
// HIDDEN_UPSTREAM switches off upstream controls these replace (tool preset, sound).

import { useEffect, useRef, useState } from "react";
import type { AgentMessage, AgentUsage } from "@/lib/types";
import { setPreferredToolPreset } from "@/lib/tool-preset-preference";

export const HIDDEN_UPSTREAM = { toolPreset: true, sound: true } as const;

// local: hidden presets must not leave a saved pin that overrides settings.json.
// Reset at module evaluation so fresh-session initialization never depends on component mount order.
if (typeof window !== "undefined") setPreferredToolPreset("configured");

type ContextUsage = { percent: number | null; contextWindow: number; tokens: number | null } | null | undefined;

function formatTokens(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 10_000) return `${(n / 1_000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Usage of the latest completed assistant response (aborted/error ones are skipped, as in pi-droid-styling). */
export function lastResponseUsage(messages: AgentMessage[]): AgentUsage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as AgentMessage & { usage?: AgentUsage; stopReason?: string };
    if (message.role !== "assistant" || !message.usage) continue;
    if (message.stopReason === "aborted" || message.stopReason === "error") continue;
    return message.usage;
  }
  return null;
}

function levelColor(percent: number): string {
  if (percent >= 80) return "#ef4444";
  if (percent >= 50) return "#eab308";
  return "#22c55e";
}

function LastUsage({ usage }: { usage: AgentUsage }) {
  const cacheRead = usage.cacheRead ?? 0;
  const prompt = (usage.input ?? 0) + cacheRead + (usage.cacheWrite ?? 0);
  const hit = prompt > 0 ? (cacheRead / prompt) * 100 : 0;
  const title = `Last response: ${usage.input ?? 0} in · ${usage.output ?? 0} out · ${cacheRead} cache read · ${usage.cacheWrite ?? 0} cache write · ${hit.toFixed(1)}% cache hit`;
  return (
    <span title={title} style={{ display: "flex", gap: 5, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>
      <span>↑{formatTokens(usage.input ?? 0)}</span>
      <span>↓{formatTokens(usage.output ?? 0)}</span>
      <span>R{formatTokens(cacheRead)}</span>
      <span>CH{hit.toFixed(0)}%</span>
    </span>
  );
}

export function ContextMeter({ usage, last }: { usage: ContextUsage; last?: AgentUsage | null }) {
  if (!usage || !usage.contextWindow) return last ? <div style={{ display: "flex", alignItems: "center", height: 32, padding: "0 4px", fontSize: 12 }}><LastUsage usage={last} /></div> : null;
  const percent = usage.percent;
  const known = percent !== null && Number.isFinite(percent);
  const clamped = known ? Math.min(100, Math.max(0, percent)) : 0;
  const color = known ? levelColor(clamped) : "var(--text-dim)";
  const used = usage.tokens !== null ? formatTokens(usage.tokens) : "?";
  const title = `Context: ${used} / ${formatTokens(usage.contextWindow)} tokens${known ? ` (${clamped.toFixed(1)}%)` : ""}`;

  return (
    <div
      title={title}
      aria-label={title}
      style={{ display: "flex", alignItems: "center", gap: 5, height: 32, padding: "0 4px", color: "var(--text-muted)", fontSize: 12, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}
    >
      <div style={{ width: 36, height: 5, borderRadius: 3, background: "var(--border)", overflow: "hidden", flexShrink: 0 }}>
        <div style={{ width: `${clamped}%`, height: "100%", background: color, borderRadius: 3, transition: "width 0.3s, background 0.3s" }} />
      </div>
      <span style={{ color: known && clamped >= 50 ? color : undefined }}>{known ? `${Math.round(clamped)}%` : "–"}</span>
      <span style={{ color: "var(--text-dim)" }}>{used}/{formatTokens(usage.contextWindow)}</span>
      {last && <span style={{ color: "var(--border)" }}>·</span>}
      {last && <LastUsage usage={last} />}
    </div>
  );
}

const TOOL_COMMANDS = [
  { command: "tools", hint: "bật / tắt" },
  { command: "defer", hint: "ẩn / hiện" },
] as const;

export function ToolsButton({ disabled, onSend }: { disabled?: boolean; onSend: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        title="Tools: /tools or /defer"
        aria-label="Tools"
        aria-expanded={open}
        style={{
          display: "flex", alignItems: "center", gap: 5,
          height: 32, padding: "0 10px",
          background: open ? "var(--bg-hover)" : "none", border: "none", borderRadius: 9,
          color: "var(--text-muted)", fontSize: 12,
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.5 : 1,
          transition: "background 0.12s, color 0.12s",
        }}
        onMouseEnter={(e) => { if (!disabled) { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; } }}
        onMouseLeave={(e) => { e.currentTarget.style.background = open ? "var(--bg-hover)" : "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
        <span>tools</span>
      </button>
      {open && (
        <div style={{
          position: "absolute", bottom: "calc(100% + 6px)", right: 0, zIndex: 100,
          background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8,
          boxShadow: "0 -4px 16px rgba(0,0,0,0.10)", overflow: "hidden", minWidth: 140,
        }}>
          {TOOL_COMMANDS.map(({ command, hint }) => (
            <button
              key={command}
              type="button"
              onClick={() => { setOpen(false); onSend(`/${command}`); }}
              style={{
                display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
                width: "100%", padding: "7px 12px",
                background: "none", border: "none", color: "var(--text)",
                cursor: "pointer", fontSize: 12, textAlign: "left", whiteSpace: "nowrap",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
            >
              <span>/{command}</span>
              <span style={{ color: "var(--text-dim)" }}>{hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
