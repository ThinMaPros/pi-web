import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-ctl-test-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;
const { dnsNameFromStatus, isServeMappingPresent, parseConfig, parseTailscalePort, piWebDataPath } = require("./pi-web-ctl.js");
test.after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  fs.rmSync(testAgentDir, { recursive: true, force: true });
});

test("CLI data path resolution without a legacy file creates nothing", () => {
  assert.equal(fs.existsSync(path.join(testAgentDir, "pi-web")), false);
});

test("CLI data path migrates a legacy file and preserves an existing destination", () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-ctl-migration-"));
  try {
    fs.writeFileSync(path.join(agentDir, "pi-web.pid"), "legacy");
    const migrated = piWebDataPath("pi-web.pid", agentDir);
    assert.equal(fs.readFileSync(migrated, "utf8"), "legacy");
    fs.writeFileSync(path.join(agentDir, "pi-web.pid"), "older");
    assert.equal(fs.readFileSync(piWebDataPath("pi-web.pid", agentDir), "utf8"), "legacy");
    assert.equal(fs.readFileSync(path.join(agentDir, "pi-web.pid"), "utf8"), "older");
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("tailscalePort defaults to 8443 and rejects invalid and reserved values", () => {
  assert.deepEqual(parseTailscalePort(undefined), { port: 8443, warnings: [] });
  assert.deepEqual(parseTailscalePort(1234), { port: 1234, warnings: [] });
  assert.deepEqual(parseTailscalePort(443), {
    port: 8443,
    warnings: ["tailscalePort 443 is reserved for another service; using 8443"],
  });
  assert.deepEqual(parseTailscalePort("8443"), {
    port: 8443,
    warnings: ["invalid tailscalePort; using 8443"],
  });
  assert.deepEqual(parseTailscalePort(65536), {
    port: 8443,
    warnings: ["invalid tailscalePort; using 8443"],
  });
});

test("config parser keeps the MagicDNS/serve port and defaults", () => {
  assert.deepEqual(parseConfig({ tailscale: true, tailscalePort: 9443 }, {}, []), {
    port: "30141",
    tailscale: true,
    tailscalePort: 9443,
    password: undefined,
    open: true,
    warnings: [],
  });
  assert.equal(parseConfig({ tailscalePort: 443 }, {}, []).tailscalePort, 8443);
  assert.equal(parseConfig({ port: 1234 }, { PORT: "5678" }, []).port, "1234");
});

test("MagicDNS name is available while Tailscale is stopped", () => {
  assert.equal(dnsNameFromStatus({ Self: { DNSName: "thinmac.tail5b7b2e.ts.net." } }), "thinmac.tail5b7b2e.ts.net");
  assert.equal(dnsNameFromStatus({ Self: { DNSName: "" } }), null);
  assert.equal(dnsNameFromStatus({}), null);
});

test("serve mapping parser recognizes the selected HTTPS port and exact local proxy", () => {
  const tcpFixture = {
    TCP: {
      "8443": {
        HTTPS: true,
        TerminateTLS: true,
        Handlers: { "/": { Proxy: "http://127.0.0.1:30141" } },
      },
    },
  };
  const webFixture = {
    Web: {
      "thinmac.tail5b7b2e.ts.net:8443": {
        Handlers: { "/": { Proxy: "http://127.0.0.1:30141" } },
      },
    },
  };
  assert.equal(isServeMappingPresent(tcpFixture, 8443, 30141), true);
  assert.equal(isServeMappingPresent(JSON.stringify(webFixture), 8443, 30141), true);
  assert.equal(isServeMappingPresent(tcpFixture, 443, 30141), false);
  assert.equal(isServeMappingPresent(webFixture, 8443, 30142), false);
  assert.equal(isServeMappingPresent({ TCP: { "8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:30141" } } } } }, 8443, 30141), false);
  assert.equal(isServeMappingPresent("not-json", 8443, 30141), false);
  assert.equal(isServeMappingPresent({}, 8443, 30141), false);
});
