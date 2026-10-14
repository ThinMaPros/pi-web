import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false, alias: { "@": new URL("../..", import.meta.url).pathname } });
const { planLiveTurn } = await jiti.import("./live-turn.ts");

const user = { role: "user", content: "hi" };
const call = (id) => ({ role: "assistant", content: [{ type: "thinking", thinking: "t" }, { type: "toolCall", id, name: "bash", arguments: {} }] });
const result = (id) => ({ role: "toolResult", toolCallId: id, content: [] });
const text = (s) => ({ type: "text", text: s });

test("all committed steps go into the group, counts include the streaming message", () => {
  const messages = [user, call("a"), result("a"), call("b"), result("b")];
  const plan = planLiveTurn(messages, 0, messages.length, { role: "assistant", content: [{ type: "toolCall", id: "c", name: "read", arguments: {} }] });
  assert.deepEqual(plan.process.map((item) => item.idx), [1, 3]);
  assert.deepEqual(plan.rest, [4]);
  assert.equal(plan.answer, null);
  assert.equal(plan.messageCount, 3);
  assert.equal(plan.toolCallCount, 3);
  assert.equal(plan.streamAnswer, null);
});

test("streaming answer text stays outside; text before a tool call moves inside", () => {
  const messages = [user, call("a"), result("a")];
  const answering = planLiveTurn(messages, 0, 3, { role: "assistant", content: [text("Repo: ")] });
  assert.equal(answering.streamProcess, null);
  assert.deepEqual(answering.streamAnswer.content, [text("Repo: ")]);
  const calling = planLiveTurn(messages, 0, 3, { role: "assistant", content: [text("Let me check"), { type: "toolCall", id: "b", name: "bash", arguments: {} }] });
  assert.equal(calling.streamAnswer, null);
  assert.equal(calling.streamProcess.content.length, 2);
  assert.equal(calling.toolCallCount, 2);
});

test("hidden custom messages are neither counted nor included in the process", () => {
  const hidden = { role: "custom", customType: "extension", display: false, content: "internal" };
  const messages = [user, hidden, call("a"), result("a")];
  const plan = planLiveTurn(messages, 0, messages.length, null);
  assert.deepEqual(plan.process.map((item) => item.idx), [2]);
  assert.equal(plan.messageCount, 1);
  assert.equal(plan.toolCallCount, 1);
});

test("a committed final answer shows outside while the turn is still busy", () => {
  const messages = [user, call("a"), result("a"), { role: "assistant", content: [text("Done")] }];
  const plan = planLiveTurn(messages, 0, messages.length, null);
  assert.deepEqual(plan.process.map((item) => item.idx), [1]);
  assert.equal(plan.answer.idx, 3);
  assert.deepEqual(plan.answer.override.content, [text("Done")]);
});
