// local: pure state for the in-app session tab strip. Tabs are keyed by
// session id only, so sessions from different directories share one strip.
// The active tab is not stored here: it is always the session AppShell shows.
// Every function returns the same state object when nothing changed, so
// callers can skip re-renders and storage writes.

export type SessionTab = { id: string; title: string; cwd: string };
export type SessionTabsState = { tabs: SessionTab[] };

export const EMPTY_SESSION_TABS: SessionTabsState = { tabs: [] };

export function sessionTabTitle(session: { id: string; name?: string; firstMessage?: string }): string {
  const firstMessage = session.firstMessage === "(no messages)" ? "" : session.firstMessage?.trim();
  return session.name?.trim() || firstMessage || session.id.slice(0, 8);
}

/** Adds the tab at the end when missing; otherwise refreshes its label. */
export function openSessionTab(state: SessionTabsState, tab: SessionTab): SessionTabsState {
  if (!state.tabs.some((item) => item.id === tab.id)) {
    return { ...state, tabs: [...state.tabs, tab] };
  }
  return syncSessionTabs(state, [tab]);
}

/** Removes a tab without choosing a replacement (e.g. the session was deleted). */
export function removeSessionTab(state: SessionTabsState, id: string): SessionTabsState {
  if (!state.tabs.some((tab) => tab.id === id)) return state;
  return { tabs: state.tabs.filter((tab) => tab.id !== id) };
}

/**
 * Closes a tab. When it was the active one, `next` is the tab to activate:
 * the right neighbour, else the left one, else null (nothing left to show).
 */
export function closeSessionTab(
  state: SessionTabsState,
  id: string,
  activeId: string | null,
): { state: SessionTabsState; next: string | null } {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  const nextState = removeSessionTab(state, id);
  if (index < 0 || id !== activeId) return { state: nextState, next: null };
  const neighbour = state.tabs[index + 1] ?? state.tabs[index - 1] ?? null;
  return { state: nextState, next: neighbour?.id ?? null };
}

/** Tab to move to for prev/next, wrapping around. Starts at an end when no tab is active. */
export function adjacentSessionTab(state: SessionTabsState, activeId: string | null, direction: 1 | -1): string | null {
  const count = state.tabs.length;
  if (count === 0) return null;
  const index = state.tabs.findIndex((tab) => tab.id === activeId);
  if (index < 0) return state.tabs[direction === 1 ? 0 : count - 1].id;
  return state.tabs[(index + direction + count) % count].id;
}

/** Drops tabs whose sessions no longer exist, keeping `keepId` (the open session). */
export function pruneSessionTabs(state: SessionTabsState, knownIds: ReadonlySet<string>, keepId: string | null): SessionTabsState {
  const tabs = state.tabs.filter((tab) => tab.id === keepId || knownIds.has(tab.id));
  return tabs.length === state.tabs.length ? state : { tabs };
}

/** Refreshes cached labels/cwds of existing tabs; never adds tabs. */
export function syncSessionTabs(state: SessionTabsState, updates: Iterable<SessionTab>): SessionTabsState {
  const byId = new Map<string, SessionTab>();
  for (const update of updates) byId.set(update.id, update);
  let changed = false;
  const tabs = state.tabs.map((tab) => {
    const update = byId.get(tab.id);
    if (!update) return tab;
    // Empty values keep the cached ones (metadata-only rows, client-built info).
    const title = update.title || tab.title;
    const cwd = update.cwd || tab.cwd;
    if (title === tab.title && cwd === tab.cwd) return tab;
    changed = true;
    return { id: tab.id, title, cwd };
  });
  return changed ? { ...state, tabs } : state;
}

export function serializeSessionTabs(state: SessionTabsState): string {
  return JSON.stringify(state.tabs.map(({ id, title, cwd }) => ({ id, title, cwd })));
}

export function reconcileSessionTabsStorageEvent(
  eventKey: string | null,
  expectedKey: string,
  newValue: string | null,
  activeTab: SessionTab | null,
): { state: SessionTabsState; activeTabAdded: boolean } | null {
  if (eventKey !== expectedKey && eventKey !== null) return null;
  const stored = parseSessionTabs(newValue);
  const activeTabAdded = Boolean(activeTab && !stored.tabs.some((tab) => tab.id === activeTab.id));
  return {
    state: activeTab ? openSessionTab(stored, activeTab) : stored,
    activeTabAdded,
  };
}

export function parseSessionTabs(raw: string | null): SessionTabsState {
  if (!raw) return EMPTY_SESSION_TABS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return EMPTY_SESSION_TABS;
    const seen = new Set<string>();
    const tabs: SessionTab[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const { id, title, cwd } = item as Record<string, unknown>;
      if (typeof id !== "string" || !id || seen.has(id)) continue;
      seen.add(id);
      tabs.push({ id, title: typeof title === "string" ? title : "", cwd: typeof cwd === "string" ? cwd : "" });
    }
    return { tabs };
  } catch {
    return EMPTY_SESSION_TABS;
  }
}
