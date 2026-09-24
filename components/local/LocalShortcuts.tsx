"use client";

// local: extra keyboard shortcuts. They press the existing upstream buttons
// (found by aria-label in every bundled locale) instead of reaching into
// component state, so no upstream file has to change.
//
//   Ctrl+Shift+L  switch pi-codex-claude account (same key as the TUI)
//   Cmd+B         toggle sidebar          (Ctrl+B off macOS)
//   Cmd+,         open Settings           (Ctrl+, off macOS)
//   Cmd+K         search sessions         (Ctrl+K off macOS)

import { useEffect } from "react";
import { enLocale } from "@/lib/i18n/messages/en";
import { zhCNLocale } from "@/lib/i18n/messages/zh-CN";
import { zhTWLocale } from "@/lib/i18n/messages/zh-TW";

const LOCALES = [enLocale, zhCNLocale, zhTWLocale];

function labels(...keys: string[]): Set<string> {
  const result = new Set<string>();
  for (const locale of LOCALES) {
    const messages = locale.messages as Record<string, string | undefined>;
    for (const key of keys) if (messages[key]) result.add(messages[key]!);
  }
  return result;
}

const SIDEBAR_TOGGLE = labels("sidebar.hide", "sidebar.show");
const SIDEBAR_SHOW = labels("sidebar.show");
const SETTINGS = labels("common.settings");

function visibleButton(match: (button: HTMLButtonElement) => boolean): HTMLButtonElement | null {
  for (const button of document.querySelectorAll<HTMLButtonElement>("button")) {
    if (button.offsetParent !== null && !button.disabled && match(button)) return button;
  }
  return null;
}

const byLabel = (set: Set<string>) => (button: HTMLButtonElement) => set.has(button.getAttribute("aria-label") ?? "");

function searchSessions(): void {
  const openSearch = () => {
    const input = document.getElementById("session-search-input");
    if (input) input.focus();
    else document.querySelector<HTMLButtonElement>('button[aria-controls="session-search-input"]')?.click();
  };
  // A collapsed sidebar stays in the DOM, so check its state, not visibility.
  if (document.querySelector(".sidebar-container.sidebar-closed")) {
    visibleButton(byLabel(SIDEBAR_SHOW))?.click();
    window.setTimeout(openSearch, 50);
    return;
  }
  openSearch();
}

export function LocalShortcuts() {
  useEffect(() => {
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
    const handler = (event: KeyboardEvent) => {
      if (event.repeat || event.altKey) return;
      const key = event.key.toLowerCase();

      if (event.ctrlKey && event.shiftKey && !event.metaKey && key === "l") {
        const button = visibleButton((b) => b.getAttribute("aria-label") === "Switch account");
        if (!button) return;
        event.preventDefault();
        button.click();
        return;
      }

      const mod = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (!mod || event.shiftKey) return;
      let action: (() => void) | null = null;
      if (key === "b") action = () => visibleButton(byLabel(SIDEBAR_TOGGLE))?.click();
      else if (key === ",") action = () => visibleButton(byLabel(SETTINGS))?.click();
      else if (key === "k") action = searchSessions;
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      action();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  return null;
}
