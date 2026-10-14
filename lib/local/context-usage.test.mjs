import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { localContextUsage, describeToolArgs, LOCAL_CONTEXT_PREVIEW_CHARS, contextToolDeclarations } = await jiti.import("./context-usage.ts");

function messageEntry(id, parentId, message) {
  return { type: "message", id, parentId, timestamp: new Date(message.timestamp).toISOString(), message };
}

function fakeSession({ entries, reserve = 16_384, compaction = true }) {
  const writes = [];
  const sessionManager = {
    getEntries: () => entries,
    getLeafId: () => entries.at(-1)?.id ?? null,
    getCwd: () => "/tmp/project",
    appendCustomEntry: () => writes.push("custom"),
    appendMessage: () => writes.push("message"),
  };
  return {
    writes,
    session: {
      sessionManager,
      settingsManager: {
        getCompactionEnabled: () => compaction,
        getCompactionReserveTokens: () => reserve,
      },
      model: { provider: "test", id: "test-model" },
      systemPrompt: "You are a helpful assistant.\nCurrent working directory: /tmp/project",
      promptTemplates: [],
      resourceLoader: { getSkills: () => ({ skills: [] }) },
      extensionRunner: {
        getRegisteredCommands: () => [],
        createCommandContext: () => ({ getSystemPromptOptions: () => ({ cwd: "/tmp/project" }) }),
      },
      getAllTools: () => [{
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        sourceInfo: { source: "builtin", path: "<builtin>", scope: "user", origin: "top-level" },
      }],
      getActiveToolNames: () => ["read"],
      getContextUsage: () => ({ tokens: 1234, contextWindow: 200_000, percent: 0.617 }),
    },
  };
}

test("context tool declarations fall back for the legacy fixture and use prepared state declarations", () => {
  const { session } = fakeSession({ entries: [] });
  const fallback = contextToolDeclarations(session);
  assert.deepEqual(fallback.activeToolNames, ["read"]);
  assert.equal(fallback.allTools[0].description, "Read a file");

  const original = session.getAllTools()[0];
  session.agent = { state: { tools: [{ ...original, description: "Prepared read declaration" }] } };
  const prepared = contextToolDeclarations(session);
  assert.deepEqual(prepared.activeToolNames, ["read"]);
  assert.equal(prepared.allTools[0].description, "Prepared read declaration");
});

test("localContextUsage classifies a session read-only and returns JSON-safe data", () => {
  const long = "x".repeat(LOCAL_CONTEXT_PREVIEW_CHARS + 100);
  const entries = [
    messageEntry("u1", null, { role: "user", content: [{ type: "text", text: "hello there" }], timestamp: 1_000 }),
    messageEntry("a1", "u1", {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "let me think" },
        { type: "text", text: "Reading." },
        { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.txt" } },
      ],
      api: "test", provider: "test", model: "test-model",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: 2_000,
    }),
    messageEntry("t1", "a1", {
      role: "toolResult", toolCallId: "c1", toolName: "read",
      content: [{ type: "text", text: long }], isError: false, timestamp: 3_000,
    }),
  ];
  const { session, writes } = fakeSession({ entries });
  const result = localContextUsage(session);

  assert.deepEqual(writes, []);
  assert.equal(result.modelLabel, "test-model");
  assert.deepEqual(result.reported, { tokens: 1234, contextWindow: 200_000, percent: 0.617 });
  assert.equal(result.autoCompactReserveTokens, 16_384);
  const ids = result.categories.map((category) => category.id);
  for (const id of ["system-prompt", "built-in-tools", "user-messages", "assistant-messages", "assistant-thinking", "tool-calls", "tool-output"]) {
    assert.ok(ids.includes(id), `missing ${id} in ${ids.join(",")}`);
  }
  assert.equal(result.estimatedTokens, result.categories.reduce((sum, category) => sum + category.tokens, 0));

  const toolOutput = result.categories.find((category) => category.id === "tool-output");
  const readOutput = toolOutput.children.find((child) => child.label === "read");
  assert.equal(readOutput.entries[0].text.length, LOCAL_CONTEXT_PREVIEW_CHARS);
  assert.equal(readOutput.entries[0].omittedChars, 100);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test("localContextUsage omits the buffer when auto-compaction is disabled", () => {
  const { session } = fakeSession({ entries: [], compaction: false });
  const result = localContextUsage(session);
  assert.equal(result.autoCompactReserveTokens, undefined);
  assert.ok(result.categories.some((category) => category.id === "system-prompt"));
});

test("tool entries carry the call detail, and user bash executions do not steal it", () => {
  const assistant = (id, parentId, calls, timestamp) => messageEntry(id, parentId, {
    role: "assistant",
    content: calls.map(([callId, name, args]) => ({ type: "toolCall", id: callId, name, arguments: args })),
    api: "test", provider: "test", model: "test-model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse", timestamp,
  });
  const result = (id, parentId, callId, toolName, text, timestamp) => messageEntry(id, parentId, {
    role: "toolResult", toolCallId: callId, toolName, content: [{ type: "text", text }], isError: false, timestamp,
  });
  const entries = [
    messageEntry("u1", null, { role: "user", content: [{ type: "text", text: "go" }], timestamp: 1_000 }),
    messageEntry("b0", "u1", { role: "bashExecution", command: "git status", output: "clean", exitCode: 0, cancelled: false, truncated: false, timestamp: 1_500 }),
    assistant("a1", "b0", [["c1", "bash", { command: "ls -la\n  src" }], ["c2", "read", { path: "a.txt", offset: 10, limit: 5 }]], 2_000),
    result("t1", "a1", "c1", "bash", "total 0", 3_000),
    result("t2", "t1", "c2", "read", "file body", 3_100),
    assistant("a2", "t2", [["c3", "bash", { command: "npm test" }]], 4_000),
    result("t3", "a2", "c3", "bash", "ok", 5_000),
  ];
  const usage = localContextUsage(fakeSession({ entries }).session);
  const output = usage.categories.find((category) => category.id === "tool-output");
  const bash = output.children.find((child) => child.label === "bash");
  assert.deepEqual(bash.entries.map((entry) => entry.detail), ["ls -la src", "npm test"]);
  assert.equal(output.children.find((child) => child.label === "read").entries[0].detail, "a.txt:10+5");
  const calls = usage.categories.find((category) => category.id === "tool-calls");
  assert.deepEqual(calls.entries.map((entry) => entry.detail), ["ls -la src", "a.txt:10+5", "npm test"]);
  const executions = output.children.find((child) => child.id === "bash-executions");
  if (executions) assert.equal(executions.entries[0].detail, "git status");
});

test("describeToolArgs summarizes common tools on one line", () => {
  assert.equal(describeToolArgs("grep", { pattern: "TODO", path: "src" }), "TODO in src");
  assert.equal(describeToolArgs("write", { path: "x.ts", content: "..." }), "x.ts");
  assert.equal(describeToolArgs("mcp", { server: "cdp", tool: "open" }), "cdp");
  assert.equal(describeToolArgs("bash", { command: "a".repeat(300) }).length, 200);
  assert.equal(describeToolArgs("noargs", {}), "");
});
