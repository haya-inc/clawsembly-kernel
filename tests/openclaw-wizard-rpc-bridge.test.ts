import assert from "node:assert/strict";
import test from "node:test";
import {
  createOpenClawWizardRpcBridgeHarness,
  resolveGatewayClientModulePath,
  wizardRpcBridgeReadyMarker
} from "../src/openclaw-wizard-rpc-bridge.ts";

test("discovers the pinned official GatewayClient facade", () => {
  const encoder = new TextEncoder();
  assert.equal(resolveGatewayClientModulePath({
    "/dist/client-other.js": encoder.encode("export const other = true;"),
    "/dist/client-exact.js": encoder.encode(
      "export { loadDeviceAuthToken as n, GatewayClient as t };"
    )
  }), "/dist/client-exact.js");
});

test("builds a persistent, loopback-only official RPC bridge", () => {
  const harness = createOpenClawWizardRpcBridgeHarness({
    clientModulePath: "/dist/client-exact.js",
    gatewayToken: "opaque-gateway-token",
    gatewayUrl: "ws://127.0.0.1:18789",
    openclawVersion: "2026.7.1-2"
  });
  assert.match(harness, /GatewayClient/u);
  assert.match(harness, /operator\.admin/u);
  assert.match(harness, /ws:\/\/127\.0\.0\.1:18789/u);
  assert.match(harness, /createConfigIO/u);
  assert.match(harness, /writeConfigFile/u);
  assert.match(harness, /agents\.list/u);
  assert.match(harness, /gateway reconnect timed out/u);
  assert.match(harness, /message!==['"]gateway not connected['"]/u);
  assert.match(harness, new RegExp(wizardRpcBridgeReadyMarker, "u"));
  assert.doesNotMatch(harness, /https?:\/\//u);
});
