import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { contextToolDeclarations } = await jiti.import("./context-usage.ts");

test("context tools match prepared request declarations, not every active tool", () => {
  const result = contextToolDeclarations({
    getAllTools: () => [
      { name: "read", description: "registered read", parameters: { old: true }, sourceInfo: { source: "pi" } },
      { name: "bash", description: "registered bash", parameters: {}, sourceInfo: { source: "pi" } },
      { name: "codemode", description: "original", parameters: {}, sourceInfo: { source: "pi" } },
      { name: "hidden", description: "hidden declaration", parameters: {}, sourceInfo: { source: "pi" } },
    ],
    getActiveToolNames: () => ["read", "bash", "codemode", "hidden"],
    agent: { state: { tools: [
      { name: "read", description: "prepared read", parameters: { path: "string" }, sourceInfo: { source: "pi" } },
      { name: "codemode", description: "rewritten codemode", parameters: { code: "string" }, sourceInfo: { source: "pi" } },
      { name: "hidden", description: "hidden declaration", parameters: {}, sourceInfo: { source: "pi" } },
    ] } },
  }, new Set(["hidden"]));
  assert.deepEqual(result.activeToolNames, ["read", "codemode"]);
  assert.deepEqual(result.allTools.map(({ name, description, parameters }) => ({ name, description, parameters })), [
    { name: "read", description: "prepared read", parameters: { path: "string" } },
    { name: "codemode", description: "rewritten codemode", parameters: { code: "string" } },
  ]);
});
