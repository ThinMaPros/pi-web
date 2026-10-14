import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { dnsNameFromStatus, isServeMappingPresent, parseConfig, parseTailscalePort } = require("./pi-web-ctl.js");

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
