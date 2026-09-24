"use client";

// local: one-click account switcher for the pi-codex-claude package.
// It only runs the package's own `/cxc:switch` command, so the account and
// model pickers (ctx.ui.select) and all account state stay inside the package.

import { useState } from "react";
import type { SlashCommandInfo } from "@/hooks/useAgentSession";
import { isAccountProvider } from "@/lib/local/account-models";

const SWITCH_COMMAND = "cxc:switch";

interface Props {
  provider?: string;
  isStreaming?: boolean;
  onSend: (message: string) => void;
  onLoadSlashCommands?: () => Promise<SlashCommandInfo[]> | SlashCommandInfo[];
}

export function AccountButton({ provider, isStreaming, onSend, onLoadSlashCommands }: Props) {
  const [missing, setMissing] = useState(false);
  const label = isAccountProvider(provider) ? provider! : "Account";
  const disabled = isStreaming || missing;

  const handleClick = async () => {
    if (disabled) return;
    // Never send "/cxc:switch" as a plain prompt when the package is not loaded.
    const commands = onLoadSlashCommands ? await Promise.resolve(onLoadSlashCommands()).catch(() => []) : [];
    if (!commands.some((command) => command.name === SWITCH_COMMAND)) {
      setMissing(true);
      return;
    }
    onSend(`/${SWITCH_COMMAND}`);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      title={missing ? "pi-codex-claude is not loaded" : "Switch account (/cxc:switch)"}
      aria-label="Switch account"
      style={{
        display: "flex", alignItems: "center", gap: 5,
        height: 32, padding: "0 8px",
        background: "none", border: "none", borderRadius: 9,
        color: "var(--text-muted)", fontSize: 12,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "background 0.12s, color 0.12s",
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = "var(--bg-hover)";
        e.currentTarget.style.color = "var(--text)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "none";
        e.currentTarget.style.color = "var(--text-muted)";
      }}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" />
      </svg>
      <span style={{ whiteSpace: "nowrap", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
    </button>
  );
}
