import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const tabs = await jiti.import("./session-tabs.ts");

const tab = (id, title = id, cwd = `/p/${id}`) => ({ id, title, cwd });
const withTabs = (...ids) => ({ tabs: ids.map((id) => tab(id)) });
const ids = (state) => state.tabs.map((item) => item.id);

test("open appends missing tabs and refreshes existing ones in place", () => {
  let state = tabs.openSessionTab(tabs.EMPTY_SESSION_TABS, tab("a", "A", "/x"));
  state = tabs.openSessionTab(state, tab("b", "B", "/y"));
  assert.deepEqual(ids(state), ["a", "b"]);
  const same = tabs.openSessionTab(state, tab("a", "A", "/x"));
  assert.equal(same, state);
  const renamed = tabs.openSessionTab(state, tab("a", "Renamed", "/x"));
  assert.deepEqual(ids(renamed), ["a", "b"]);
  assert.equal(renamed.tabs[0].title, "Renamed");
});

test("closing the active tab activates the right neighbour, else left, else none", () => {
  const state = withTabs("a", "b", "c");
  assert.deepEqual(tabs.closeSessionTab(state, "b", "b").next, "c");
  assert.deepEqual(tabs.closeSessionTab(state, "c", "c").next, "b");
  const last = tabs.closeSessionTab(withTabs("a"), "a", "a");
  assert.equal(last.next, null);
  assert.deepEqual(ids(last.state), []);
  const inactive = tabs.closeSessionTab(state, "a", "c");
  assert.equal(inactive.next, null);
  assert.deepEqual(ids(inactive.state), ["b", "c"]);
});

test("prev/next follow visual order and wrap", () => {
  const state = withTabs("a", "b", "c");
  assert.equal(tabs.adjacentSessionTab(state, "c", 1), "a");
  assert.equal(tabs.adjacentSessionTab(state, "a", -1), "c");
  assert.equal(tabs.adjacentSessionTab(state, "b", 1), "c");
  assert.equal(tabs.adjacentSessionTab(state, null, 1), "a");
  assert.equal(tabs.adjacentSessionTab(state, null, -1), "c");
  assert.equal(tabs.adjacentSessionTab(tabs.EMPTY_SESSION_TABS, null, 1), null);
});

test("prune drops unknown sessions but keeps the open one", () => {
  const state = withTabs("a", "b", "c");
  const pruned = tabs.pruneSessionTabs(state, new Set(["a"]), "c");
  assert.deepEqual(ids(pruned), ["a", "c"]);
  assert.equal(tabs.pruneSessionTabs(state, new Set(["a", "b", "c"]), null), state);
});

test("sync only updates labels of existing tabs and keeps cached values for empty ones", () => {
  const state = withTabs("a", "b");
  assert.equal(tabs.syncSessionTabs(state, [tab("a")]), state);
  assert.equal(tabs.syncSessionTabs(state, [{ id: "a", title: "", cwd: "" }]), state);
  const next = tabs.syncSessionTabs(state, [tab("a", "New"), tab("z", "Z")]);
  assert.deepEqual(ids(next), ["a", "b"]);
  assert.equal(next.tabs[0].title, "New");
  assert.equal(next.tabs[1], state.tabs[1]);
});

test("storage round-trips tabs and tolerates junk", () => {
  const state = withTabs("a", "b");
  const restored = tabs.parseSessionTabs(tabs.serializeSessionTabs(state));
  assert.deepEqual(restored, state);
  assert.deepEqual(tabs.parseSessionTabs("not json"), tabs.EMPTY_SESSION_TABS);
  assert.deepEqual(tabs.parseSessionTabs(null), tabs.EMPTY_SESSION_TABS);
  assert.deepEqual(
    ids(tabs.parseSessionTabs(JSON.stringify([{ id: "a" }, { id: "a" }, { title: "x" }, null, { id: "b", title: 3 }]))),
    ["a", "b"],
  );
});

test("storage events retain the active tab and report when it must be written back", () => {
  const active = tab("open", "Open", "/open");
  const update = tabs.reconcileSessionTabsStorageEvent("pi-local-session-tabs", "pi-local-session-tabs", '[{"id":"other"}]', active);
  assert.deepEqual(ids(update.state), ["other", "open"]);
  assert.equal(update.activeTabAdded, true);
  const unchanged = tabs.reconcileSessionTabsStorageEvent("pi-local-session-tabs", "pi-local-session-tabs", '[{"id":"open","title":"Open","cwd":"/open"}]', active);
  assert.deepEqual(ids(unchanged.state), ["open"]);
  assert.equal(unchanged.activeTabAdded, false);
  assert.equal(tabs.reconcileSessionTabsStorageEvent("other", "pi-local-session-tabs", null, active), null);
  const cleared = tabs.reconcileSessionTabsStorageEvent(null, "pi-local-session-tabs", null, active);
  assert.deepEqual(ids(cleared.state), ["open"]);
  assert.equal(cleared.activeTabAdded, true);
});

test("title falls back to first message, then a short id", () => {
  assert.equal(tabs.sessionTabTitle({ id: "abcdef123456", name: "Named", firstMessage: "hi" }), "Named");
  assert.equal(tabs.sessionTabTitle({ id: "abcdef123456", firstMessage: " hi " }), "hi");
  assert.equal(tabs.sessionTabTitle({ id: "abcdef123456", firstMessage: "(no messages)" }), "abcdef12");
});
