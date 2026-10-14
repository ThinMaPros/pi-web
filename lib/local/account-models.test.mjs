import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { accountButtonLabel, filterAccountModels } = await jiti.import("./account-models.ts");

const models = [
  { provider: "cxc-claude", id: "claude" },
  { provider: "cxc-codex", id: "codex" },
  { provider: "claude-account-6-one", id: "claude-one" },
  { provider: "codex-two", id: "codex-two" },
  { provider: "anthropic", id: "native" },
];

test("public cxc providers remain visible across families and show a family label", () => {
  assert.deepEqual(filterAccountModels(models, "cxc-claude"), [models[0], models[1], models[4]]);
  assert.equal(accountButtonLabel("cxc-claude"), "Claude");
  assert.deepEqual(filterAccountModels(models, "cxc-codex"), [models[0], models[1], models[4]]);
  assert.equal(accountButtonLabel("cxc-codex"), "Codex");
});

test("an account alias shows its models and public models, with alias label", () => {
  assert.deepEqual(filterAccountModels(models, "claude-account-6-one"), [models[0], models[1], models[2], models[4]]);
  assert.equal(accountButtonLabel("claude-account-6-one"), "claude-account-6-one");
});

test("unrelated and unset providers still hide every account alias", () => {
  assert.deepEqual(filterAccountModels(models, "anthropic"), [models[0], models[1], models[4]]);
  assert.deepEqual(filterAccountModels(models, undefined), [models[0], models[1], models[4]]);
  assert.equal(accountButtonLabel("anthropic"), "Account");
});
