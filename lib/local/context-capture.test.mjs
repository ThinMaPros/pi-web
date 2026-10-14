import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// Shared module cache: context-usage.ts must see the same capture registry as this test.
const jiti = createJiti(import.meta.url, { interopDefault: true });
const capture = await jiti.import("./context-capture.ts");
const { localContextUsage } = await jiti.import("./context-usage.ts");

const NATIVE_PROMPT = "You are a helpful assistant.\nCurrent working directory: /tmp/project";
const ADDITION = "\n\nFor web lookups call web_search from pi-web-providers.";

function messageEntry(id, parentId, message) {
  return { type: "message", id, parentId, timestamp: new Date(message.timestamp).toISOString(), message };
}

const tools = [
  {
    name: "read",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    sourceInfo: { source: "builtin", path: "<builtin>", scope: "user", origin: "top-level" },
  },
  {
    name: "web_search",
    description: "Search the web",
    parameters: { type: "object", properties: { query: { type: "string" } } },
    sourceInfo: { source: "npm:pi-web-providers", path: "/x/node_modules/pi-web-providers/index.ts", scope: "user", origin: "package", baseDir: "/x/node_modules/pi-web-providers" },
  },
];

function setup(sessionId = "s1") {
  const entries = [
    messageEntry("u1", null, { role: "user", content: [{ type: "text", text: "hello there" }], timestamp: 1_000 }),
  ];
  const writes = [];
  const sessionManager = {
    getSessionId: () => sessionId,
    getEntries: () => entries,
    getLeafId: () => entries.at(-1)?.id ?? null,
    getCwd: () => "/tmp/project",
    appendCustomEntry: () => writes.push("custom"),
    appendMessage: () => writes.push("message"),
  };
  const handlers = new Map();
  const pi = {
    on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    getAllTools: () => tools,
    getActiveTools: () => ["read", "web_search"],
    getCommands: () => [],
    sendMessage: () => writes.push("sendMessage"),
    sendUserMessage: () => writes.push("sendUserMessage"),
    appendEntry: () => writes.push("appendEntry"),
  };
  const ctx = { sessionManager, getSystemPrompt: () => NATIVE_PROMPT + ADDITION };
  const session = {
    sessionManager,
    settingsManager: { getCompactionEnabled: () => true, getCompactionReserveTokens: () => 16_384 },
    model: { provider: "test", id: "test-model" },
    systemPrompt: NATIVE_PROMPT + ADDITION,
    promptTemplates: [],
    resourceLoader: { getSkills: () => ({ skills: [] }) },
    extensionRunner: {
      getRegisteredCommands: () => [],
      createCommandContext: () => ({ getSystemPromptOptions: () => ({ cwd: "/tmp/project" }) }),
    },
    getAllTools: () => tools,
    getActiveToolNames: () => ["read", "web_search"],
    getContextUsage: () => ({ tokens: 1234, contextWindow: 200_000, percent: 0.617 }),
  };
  return { entries, writes, sessionManager, handlers, pi, ctx, session };
}

const reminder = {
  role: "custom",
  customType: "todo-reminder",
  content: "Remember the open TODO items: ship the Injections tab.",
  display: false,
  timestamp: 1_500,
};

async function runRequest(env) {
  const extension = capture.createLocalContextCaptureExtension();
  assert.equal(extension.hidden, true);
  extension.factory(env.pi);
  const options = { cwd: "/tmp/project", selectedTools: ["read", "web_search"], toolSnippets: {}, sections: {}, contextFiles: [], skills: [] };
  const beforeEvent = { type: "before_agent_start", prompt: "hello", systemPrompt: NATIVE_PROMPT + ADDITION, systemPromptOptions: options };
  const results = [];
  for (const handler of env.handlers.get("before_agent_start")) results.push(await handler(beforeEvent, env.ctx));
  const messages = [env.entries[0].message, reminder];
  const snapshotBefore = JSON.stringify(messages);
  const contextEvent = { type: "context", messages };
  for (const handler of env.handlers.get("context")) results.push(await handler(contextEvent, env.ctx));
  return { results, messages, snapshotBefore, contextEvent };
}

test("capture handlers are passive and register only before_agent_start + context", async () => {
  const env = setup();
  const { results, messages, snapshotBefore, contextEvent } = await runRequest(env);
  assert.deepEqual([...env.handlers.keys()].sort(), ["before_agent_start", "context"]);
  assert.ok(results.every((result) => result === undefined));
  assert.equal(contextEvent.messages, messages);
  assert.equal(JSON.stringify(messages), snapshotBefore);
  assert.deepEqual(env.writes, []);
});

test("registry holds the Initial and latest snapshots, keyed by session manager + id", async () => {
  const env = setup();
  assert.equal(capture.readLocalContextCapture(env.sessionManager), undefined);
  await runRequest(env);
  const result = capture.readLocalContextCapture(env.sessionManager);
  assert.ok(result?.initial);
  assert.ok(result.latest);
  assert.equal(result.initial.origin, "real-turn");
  const items = result.initial.groups.flatMap((group) => group.items);
  const message = items.find((item) => item.kind === "message");
  assert.equal(message.requestOnly, true);
  assert.equal(message.source.label, "todo-reminder");
  const addition = items.find((item) => item.kind === "prompt-addition");
  assert.ok(addition, "extension prompt addition is measured");
  assert.equal(addition.source.label, "npm:pi-web-providers");
  assert.match(addition.text, /web_search/);

  // A different manager (or a new session id on the same manager) has no capture.
  assert.equal(capture.readLocalContextCapture({ ...env.sessionManager }), undefined);
  const renamed = { ...env.sessionManager, getSessionId: () => "s2" };
  assert.equal(capture.readLocalContextCapture(renamed), undefined);
});

test("Initial stays frozen while latest follows later requests", async () => {
  const env = setup();
  await runRequest(env);
  const first = capture.readLocalContextCapture(env.sessionManager);
  const other = { ...reminder, customType: "later-note", content: "second request only" };
  for (const handler of env.handlers.get("context")) await handler({ type: "context", messages: [env.entries[0].message, other] }, env.ctx);
  const second = capture.readLocalContextCapture(env.sessionManager);
  assert.equal(second.initial, first.initial);
  const latestLabels = second.latest.groups.flatMap((group) => group.items).filter((item) => item.kind === "message").map((item) => item.source.label);
  assert.deepEqual(latestLabels, ["later-note"]);
});

test("Usage counts the request-only message and Injections returns a tree with TOTAL", async () => {
  const env = setup();
  const before = localContextUsage(env.session);
  assert.equal(before.injections.source, "static");
  assert.ok(before.injections.groups.length > 0);
  assert.match(before.injectionsNotes[0], /no request observed in this server run yet/);
  assert.match(before.notes[0], /not captured yet/);
  const beforeHasReminder = JSON.stringify(before.categories).includes("todo-reminder");
  assert.equal(beforeHasReminder, false);

  await runRequest(env);
  const usage = localContextUsage(env.session);
  assert.deepEqual(env.writes, []);
  assert.match(usage.notes[0], /counted from the latest request/);
  const extensions = usage.categories.find((category) => JSON.stringify(category).includes("todo-reminder"));
  assert.ok(extensions, "request-only message is counted in Usage");
  assert.ok(usage.estimatedTokens > before.estimatedTokens);

  const injections = usage.injections;
  assert.equal(injections.source, "captured");
  assert.ok(injections);
  assert.deepEqual(JSON.parse(JSON.stringify(usage)), usage);
  assert.equal(injections.origin, "real-turn");
  assert.ok(!Number.isNaN(Date.parse(injections.capturedAt)));
  const labels = injections.groups.map((group) => group.label);
  assert.ok(labels.includes("pi"), labels.join(","));
  assert.ok(labels.includes("todo-reminder"), labels.join(","));
  assert.ok(labels.includes("npm:pi-web-providers"), labels.join(","));
  assert.equal(injections.totalTokens, injections.groups.reduce((sum, group) => sum + group.tokens, 0));
  for (const group of injections.groups) {
    assert.equal(group.kind, "group");
    assert.equal(group.tokens, group.children.reduce((sum, child) => sum + child.tokens, 0));
  }
  const reminderNode = injections.groups.find((group) => group.label === "todo-reminder").children[0];
  assert.equal(reminderNode.requestOnly, true);
  assert.match(reminderNode.preview, /open TODO items/);
  const provider = injections.groups.find((group) => group.label === "npm:pi-web-providers");
  const tool = provider.children.find((child) => child.label === "web_search");
  assert.match(tool.preview, /"query": \{/, "tool schema JSON is pretty-printed");
  const addition = provider.children.find((child) => child.id.startsWith("prompt-addition") || /prompt/i.test(child.label));
  assert.ok(addition?.guessed, "prompt addition is marked as a guess");
  const systemPrompt = injections.groups.find((group) => group.label === "pi").children.find((child) => child.label === "System Prompt");
  assert.ok(systemPrompt.children?.length, "System Prompt has sub-items");
  assert.ok(usage.injectionsNotes.length > 0);
});

test("exact-prompt sessions still show the static injections tree", () => {
  const env = setup();
  const usage = localContextUsage(env.session, "custom prompt");
  assert.equal(usage.injections.source, "static");
  assert.ok(usage.injections.totalTokens > 0);
});
