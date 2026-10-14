import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { piWebDataPath } = await createJiti(import.meta.url).import("./pi-web-data.ts");

function temporaryAgentDir(t) {
  const root = fs.mkdtempSync(join(tmpdir(), "pi-web-data-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return join(root, "agent");
}

test("resolving without a legacy file creates nothing", (t) => {
  const agentDir = temporaryAgentDir(t);
  assert.equal(piWebDataPath("state.json", agentDir), join(agentDir, "pi-web", "state.json"));
  assert.equal(fs.existsSync(agentDir), false);
});

test("migrates a legacy file", (t) => {
  const agentDir = temporaryAgentDir(t);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(join(agentDir, "state.json"), "legacy");
  const path = piWebDataPath("state.json", agentDir);
  assert.equal(fs.readFileSync(path, "utf8"), "legacy");
  assert.equal(fs.statSync(join(agentDir, "pi-web")).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(join(agentDir, "state.json")), false);
});

test("keeps both files when the new location already exists", (t) => {
  const agentDir = temporaryAgentDir(t);
  fs.mkdirSync(join(agentDir, "pi-web"), { recursive: true });
  fs.writeFileSync(join(agentDir, "pi-web", "state.json"), "new");
  fs.writeFileSync(join(agentDir, "state.json"), "legacy");
  assert.equal(fs.readFileSync(piWebDataPath("state.json", agentDir), "utf8"), "new");
  assert.equal(fs.readFileSync(join(agentDir, "state.json"), "utf8"), "legacy");
});

test("tolerates a legacy file disappearing before migration", (t) => {
  const agentDir = temporaryAgentDir(t);
  assert.equal(piWebDataPath("state.json", agentDir), join(agentDir, "pi-web", "state.json"));
  assert.equal(fs.existsSync(join(agentDir, "pi-web", "state.json")), false);
});
