import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  enabledModelsBulkActions,
  filterEnabledModels,
  isLastEnabledModel,
  providerBadgeLabel,
} = await jiti.import("./enabled-models-helpers.ts");

const source = await readFile(new URL("./EnabledModelsSection.tsx", import.meta.url), "utf8");
const modelsConfigSource = await readFile(new URL("./ModelsConfig.tsx", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/settings.css", import.meta.url), "utf8");

const entry = (id, enabled, extra = {}) => ({
  id,
  name: id.toUpperCase(),
  ref: `anthropic/${id}`,
  enabled,
  ...extra,
});

function view(models, overrides = {}) {
  return {
    allEnabled: false,
    patterns: ["anthropic/*"],
    stalePatterns: [],
    enabledTotal: models.filter((model) => model.enabled).length,
    availableTotal: models.length,
    providers: [{
      id: "anthropic",
      name: "Anthropic",
      kind: "builtin",
      enabledCount: models.filter((model) => model.enabled).length,
      models,
    }],
    scope: "global",
    editable: true,
    ...overrides,
  };
}

test("the filter matches model ids and display names", () => {
  const models = [entry("sonnet", true), entry("opus", false)];
  assert.deepEqual(filterEnabledModels(models, "opu").map((model) => model.id), ["opus"]);
  assert.deepEqual(filterEnabledModels(models, "SONNET").map((model) => model.id), ["sonnet"]);
  assert.equal(filterEnabledModels(models, "   ").length, 2);
});

test("bulk actions only offer the direction that changes something", () => {
  const models = [entry("sonnet", true), entry("opus", false)];
  // Other providers keep models on, so both directions are live here.
  const actions = enabledModelsBulkActions(view(models, { enabledTotal: 4 }), models);
  assert.deepEqual(actions.enableRefs, ["anthropic/opus"]);
  assert.deepEqual(actions.disableRefs, ["anthropic/sonnet"]);
  assert.equal(actions.canEnable, true);
  assert.equal(actions.canDisable, true);

  const allOn = [entry("sonnet", true), entry("opus", true)];
  assert.equal(enabledModelsBulkActions(view(allOn), allOn).canEnable, false);
});

test("a bulk disable that would empty the scope is withheld", () => {
  const models = [entry("sonnet", true), entry("opus", false)];
  const actions = enabledModelsBulkActions(view(models), models);
  assert.equal(actions.canDisable, false);
  assert.deepEqual(actions.disableRefs, ["anthropic/sonnet"]);
});

test("a bulk disable stays available while other providers keep models on", () => {
  const models = [entry("sonnet", true)];
  const scoped = view(models, { enabledTotal: 3, availableTotal: 5 });
  assert.equal(enabledModelsBulkActions(scoped, models).canDisable, true);
});

test("read-only project scope disables both bulk actions", () => {
  const models = [entry("sonnet", true), entry("opus", false)];
  const readOnly = view(models, { scope: "project", editable: false, enabledTotal: 4 });
  const actions = enabledModelsBulkActions(readOnly, models);
  assert.equal(actions.canEnable, false);
  assert.equal(actions.canDisable, false);
});

test("the last enabled model is locked on", () => {
  const models = [entry("sonnet", true), entry("opus", false)];
  const single = view(models);
  assert.equal(isLastEnabledModel(single, models[0]), true);
  assert.equal(isLastEnabledModel(single, models[1]), false);
  assert.equal(isLastEnabledModel(view(models, { enabledTotal: 2 }), models[0]), false);
});

test("the sidebar badge only appears while the selector is narrowed", () => {
  const models = [entry("sonnet", true), entry("opus", false)];
  assert.equal(providerBadgeLabel(view(models), "anthropic"), "1/2");
  assert.equal(providerBadgeLabel(view(models, { allEnabled: true }), "anthropic"), null);
  assert.equal(providerBadgeLabel(view(models), "openai"), null);
  assert.equal(providerBadgeLabel(null, "anthropic"), null);
});

test("edits are serialized so two writes cannot race on the settings file", () => {
  assert.match(source, /if \(pendingRef\.current\) return;/);
  assert.match(source, /pendingRef\.current = key;/);
  assert.match(source, /const busy = pending !== null;/);
});

test("an unfiltered bulk action is resolved by the server, a filtered one by refs", () => {
  assert.match(
    source,
    /if \(filtered\) controller\.setModels\(bulkKey, refs, enabled\);\s*\n\s*else controller\.setProvider\(provider\.id, enabled\);/,
  );
});

test("known refusals are shown as localized text, not raw server strings", () => {
  assert.match(source, /"last-model": "models\.enabledLastModel"/);
  assert.match(source, /"project-scope": "models\.enabledProjectScope"/);
  assert.match(source, /failure\.messageKey \? t\(failure\.messageKey\) : failure\.message/);
});

test("switches are locked while the scope is not editable", () => {
  assert.match(source, /disabled=\{busy \|\| !view\?\.editable \|\| lastOne\}/);
});

test("custom providers get the provider-level actions only", () => {
  assert.match(source, /const custom = provider\.kind === "custom";/);
  assert.match(source, /const shown = custom \? provider\.models : filterEnabledModels/);
  assert.match(source, /custom \? \(\s*\n\s*<div className="enabled-models-note">\{t\("models\.enabledCustomHint"\)\}<\/div>/);
});

test("the section is mounted for built-in, api-key and custom providers", () => {
  assert.match(
    modelsConfigSource,
    /provider\.loggedIn && <EnabledModelsSection providerId=\{provider\.id\} controller=\{enabledModels\} \/>/,
  );
  assert.match(
    modelsConfigSource,
    /provider\.configured && <EnabledModelsSection providerId=\{provider\.id\} controller=\{enabledModels\} \/>/,
  );
  assert.match(
    modelsConfigSource,
    /<EnabledModelsSection providerId=\{name\} controller=\{enabledModels\} \/>/,
  );
  assert.match(modelsConfigSource, /<EnabledModelsBanner controller=\{enabledModels\} \/>/);
});

test("the banner offers to prune unmatched entries only when there are some", () => {
  assert.match(source, /view\.editable && stale > 0 && \(/);
  assert.match(source, /onClick=\{controller\.pruneStale\}/);
  assert.match(source, /const pruneStale = useCallback\(\(\) => mutate\("prune", \{ op: "prune" \}\)/);
});

test("provider rows carry the scope badge", () => {
  const sidebar = modelsConfigSource.slice(
    modelsConfigSource.indexOf("<ConfigSidebar>"),
    modelsConfigSource.indexOf("</ConfigSidebar>"),
  );
  assert.equal(sidebar.match(/\{scopeBadge\(/g)?.length, 3);
  assert.match(cssSource, /\.models-sidebar-badge \{/);
  assert.match(cssSource, /\.enabled-models-row \+ \.enabled-models-row \{/);
});
