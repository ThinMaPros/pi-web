"use client";

// local: session tab strip above the chat (desktop). Tabs are client-side only:
// the server keeps every session alive on its own, so closing a tab never stops
// a session. Tab state lives in a module store (pure logic in
// lib/local/session-tabs.ts) so tab changes re-render this strip, not AppShell.
//
// Wiring in AppShell: the open session is added as a tab whatever route opened
// it (sidebar, search, URL, new session, fork); clicking a tab goes through
// AppShell's handleSelectSession, the same path as a sidebar click.
//
//   Ctrl+Shift+[  previous tab      Ctrl+Shift+]  next tab   (wraps around)

import { memo, useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { SessionInfo } from "@/lib/types";
import {
  adjacentSessionTab,
  closeSessionTab,
  EMPTY_SESSION_TABS,
  openSessionTab,
  parseSessionTabs,
  pruneSessionTabs,
  removeSessionTab as removeTab,
  serializeSessionTabs,
  reconcileSessionTabsStorageEvent,
  sessionTabTitle,
  syncSessionTabs,
  type SessionTab,
  type SessionTabsState,
} from "@/lib/local/session-tabs";

const STORAGE_KEY = "pi-local-session-tabs";

let state: SessionTabsState = EMPTY_SESSION_TABS;
let loaded = false;
const listeners = new Set<() => void>();
let activeSessionTab: SessionTab | null = null;

function ensureLoaded(): void {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    state = parseSessionTabs(window.localStorage.getItem(STORAGE_KEY));
  } catch { /* storage is optional */ }
}

function getSnapshot(): SessionTabsState {
  ensureLoaded();
  return state;
}

const getServerSnapshot = () => EMPTY_SESSION_TABS;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") {
    window.addEventListener("storage", handleStorage);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", handleStorage);
    }
  };
}

function handleStorage(event: StorageEvent): void {
  let raw: string | null;
  try { raw = event.key === null ? null : window.localStorage.getItem(STORAGE_KEY); }
  catch { raw = event.newValue; }
  const update = reconcileSessionTabsStorageEvent(event.key, STORAGE_KEY, raw, activeSessionTab);
  if (!update) return;
  const next = update.state;
  const changed = serializeSessionTabs(next) !== serializeSessionTabs(state);
  if (changed) state = next;
  if (update.activeTabAdded) {
    try { window.localStorage.setItem(STORAGE_KEY, serializeSessionTabs(next)); }
    catch { /* storage is optional */ }
  }
  if (changed) listeners.forEach((listener) => listener());
}

function update(change: (current: SessionTabsState) => SessionTabsState): void {
  ensureLoaded();
  const next = change(state);
  if (next === state) return;
  const tabsChanged = next.tabs !== state.tabs;
  state = next;
  if (tabsChanged) {
    try {
      window.localStorage.setItem(STORAGE_KEY, serializeSessionTabs(next));
    } catch { /* storage is optional */ }
  }
  listeners.forEach((listener) => listener());
}

/** Drop a tab without navigating (the session was deleted in-app). */
export function removeSessionTab(sessionId: string): void {
  update((current) => removeTab(current, sessionId));
}

function toTab(session: SessionInfo): SessionTab {
  // An empty title keeps the cached label (catalog rows can be metadata-only).
  const hasLabel = Boolean(session.name || (session.firstMessage && session.firstMessage !== "(no messages)"));
  const title = hasLabel ? sessionTabTitle(session) : "";
  return { id: session.id, title, cwd: session.cwd };
}

interface Props {
  hidden?: boolean;
  activeSession: SessionInfo | null;
  sessions: SessionInfo[];
  runningSessionIds: ReadonlySet<string>;
  awaitingInputSessionIds: ReadonlySet<string>; // local: session tabs
  onSelectSession: (session: SessionInfo) => void;
  onNewSession: (sessionId: string, cwd: string) => void;
}

export const SessionTabs = memo(function SessionTabs({
  hidden = false,
  activeSession,
  sessions,
  runningSessionIds,
  awaitingInputSessionIds, // local: session tabs
  onSelectSession,
  onNewSession,
}: Props) {
  const { tabs } = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const activeId = activeSession?.id ?? null;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const activeSessionRef = useRef(activeSession);
  activeSessionRef.current = activeSession;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const callbacksRef = useRef({ onSelectSession, onNewSession });
  callbacksRef.current = { onSelectSession, onNewSession };
  // Bumped on every tab activation so a slow lookup cannot open a stale tab.
  const openTokenRef = useRef(0);

  useEffect(() => {
    activeSessionTab = activeSession ? toTab(activeSession) : null;
    return () => { activeSessionTab = null; };
  }, [activeSession]);

  // Any route that opens a session (sidebar, search, URL, new, fork) ends in
  // AppShell selecting it; only real ids get here, never the new-session composer.
  useEffect(() => {
    const session = activeSessionRef.current;
    if (!session) return;
    update((current) => openSessionTab(current, toTab(session)));
  }, [activeId]);

  // Keep cached labels fresh. Catalog rows win over the open session's
  // client-built info (a fork starts with its parent's name).
  useEffect(() => {
    const ids = new Set(getSnapshot().tabs.map((tab) => tab.id));
    const updates: SessionTab[] = activeSession && ids.has(activeSession.id) ? [toTab(activeSession)] : [];
    for (const session of sessions) if (ids.has(session.id)) updates.push(toTab(session));
    update((current) => syncSessionTabs(current, updates));
  }, [activeSession, sessions]);

  // Once the first session list arrives, drop restored tabs whose sessions are gone.
  const prunedRef = useRef(false);
  useEffect(() => {
    if (prunedRef.current || sessions.length === 0) return;
    prunedRef.current = true;
    const known = new Set(sessions.map((session) => session.id));
    update((current) => pruneSessionTabs(current, known, activeIdRef.current));
  }, [sessions]);

  const activate = useCallback((id: string) => {
    const token = ++openTokenRef.current;
    if (id === activeIdRef.current) return;
    const catalogued = sessionsRef.current.find((session) => session.id === id);
    if (catalogued && !catalogued.transient) {
      callbacksRef.current.onSelectSession(catalogued);
      return;
    }
    const startedFrom = activeIdRef.current;
    void fetch(`/api/sessions/${encodeURIComponent(id)}`, { cache: "no-store" })
      .then(async (response) => {
        if (response.status === 404) {
          removeSessionTab(id);
          return;
        }
        const data = await response.json() as { info?: SessionInfo; error?: string };
        if (!response.ok || !data.info) throw new Error(data.error ?? `HTTP ${response.status}`);
        // Ignore if another tab was picked or the user navigated elsewhere meanwhile.
        if (token !== openTokenRef.current || activeIdRef.current !== startedFrom) return;
        callbacksRef.current.onSelectSession(data.info);
      })
      .catch((error) => {
        console.error("[pi-web] failed to open session tab:", error instanceof Error ? error.message : error);
      });
  }, []);

  const close = useCallback((id: string) => {
    const closedTab = getSnapshot().tabs.find((tab) => tab.id === id);
    const result = closeSessionTab(getSnapshot(), id, activeIdRef.current);
    update(() => result.state);
    if (id !== activeIdRef.current) return;
    if (result.next) {
      activate(result.next);
      return;
    }
    // Nothing left: show what upstream shows with no session, the new-session composer.
    openTokenRef.current += 1;
    const cwd = activeSessionRef.current?.cwd || closedTab?.cwd;
    if (cwd) callbacksRef.current.onNewSession(`tab-${Date.now()}`, cwd);
  }, [activate]);

  useEffect(() => {
    if (hidden) return;
    const handler = (event: KeyboardEvent) => {
      if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return;
      // event.key for Shift+[ is "{" on US layouts, so match the physical key.
      const direction = event.code === "BracketLeft" ? -1 : event.code === "BracketRight" ? 1 : 0;
      if (!direction) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      const next = adjacentSessionTab(getSnapshot(), activeIdRef.current, direction);
      if (next) activate(next);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [activate, hidden]);

  if (hidden || tabs.length === 0) return null;

  return (
    <div
      role="tablist"
      aria-label="Session tabs"
      style={{
        display: "flex",
        alignItems: "stretch",
        flexShrink: 0,
        height: 30,
        overflowX: "auto",
        background: "var(--bg-panel)",
        borderBottom: "1px solid var(--border)",
      }}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeId;
        const needsAttention = awaitingInputSessionIds.has(tab.id);
        const running = runningSessionIds.has(tab.id);
        const label = tab.title || tab.id.slice(0, 8);
        const status = needsAttention ? "Needs attention" : running ? "Running" : null;
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            title={[label, tab.cwd, status].filter(Boolean).join("\n")}
            onClick={() => activate(tab.id)}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                activate(tab.id);
              }
            }}
            onMouseDown={(event) => {
              if (event.button === 1) event.preventDefault();
            }}
            onAuxClick={(event) => {
              if (event.button !== 1) return;
              event.preventDefault();
              event.stopPropagation();
              close(tab.id);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              paddingLeft: 10,
              paddingRight: 4,
              minWidth: 90,
              maxWidth: 200,
              flexShrink: 0,
              borderRight: "1px solid var(--border)",
              borderTop: isActive ? "2px solid var(--accent)" : "2px solid transparent",
              background: isActive ? "var(--bg)" : "var(--bg-panel)",
              color: isActive ? "var(--text)" : "var(--text-muted)",
              fontSize: 12,
              whiteSpace: "nowrap",
              cursor: "pointer",
              userSelect: "none",
              transition: "background 0.1s, color 0.1s",
            }}
          >
            <span
              aria-label={status ?? undefined}
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                flexShrink: 0,
                background: needsAttention ? "#d97706" : running ? "var(--accent)" : "transparent",
                animation: running && !needsAttention ? "pulse 1.6s ease-in-out infinite" : undefined,
              }}
            />
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", fontWeight: isActive ? 500 : 400 }}>
              {label}
            </span>
            <button
              type="button"
              tabIndex={-1}
              onClick={(event) => { event.stopPropagation(); close(tab.id); }}
              title="Close tab"
              aria-label={`Close tab ${label}`}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 20, height: 20, padding: 0, flexShrink: 0,
                background: "transparent", border: "none", borderRadius: 4,
                color: "var(--text-dim)", cursor: "pointer",
              }}
              onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; event.currentTarget.style.color = "var(--text)"; }}
              onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; event.currentTarget.style.color = "var(--text-dim)"; }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <line x1="2" y1="2" x2="8" y2="8" />
                <line x1="8" y1="2" x2="2" y2="8" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
});
