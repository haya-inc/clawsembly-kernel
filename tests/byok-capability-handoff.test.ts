import assert from "node:assert/strict";
import test from "node:test";
import {
  clearByokCapabilityHandoff,
  consumeByokCapabilityHandoff,
  stageByokCapabilityHandoff
} from "../src/byok-capability-handoff.ts";

test("hands an opaque capability to the runtime exactly once", () => {
  clearByokCapabilityHandoff();
  stageByokCapabilityHandoff({
    apiKey: "opaque-guest-capability",
    apiPath: "/v1/chat/completions",
    baseUrl: "https://clawsembly.yhay81.com/api/byok/v1",
    expiresAt: "2026-07-29T01:00:00.000Z",
    modelApi: "openai-completions",
    model: "gpt-5.6",
    openClawProvider: "clawsembly-byok",
    providerId: "clawsembly-byok"
  });

  assert.deepEqual(consumeByokCapabilityHandoff(), {
    apiKey: "opaque-guest-capability",
    apiPath: "/v1/chat/completions",
    baseUrl: "https://clawsembly.yhay81.com/api/byok/v1",
    expiresAt: "2026-07-29T01:00:00.000Z",
    modelApi: "openai-completions",
    model: "gpt-5.6",
    openClawProvider: "clawsembly-byok",
    providerId: "clawsembly-byok"
  });
  assert.equal(consumeByokCapabilityHandoff(), undefined);
});

test("rejects malformed handoff values", () => {
  clearByokCapabilityHandoff();
  stageByokCapabilityHandoff({
    apiKey: "opaque-guest-capability",
    apiPath: "/v1/chat/completions",
    baseUrl: "http://insecure.example/v1",
    expiresAt: "2026-07-29T01:00:00.000Z",
    modelApi: "openai-completions",
    model: "gpt-5.6",
    openClawProvider: "clawsembly-byok",
    providerId: "clawsembly-byok"
  });
  assert.equal(consumeByokCapabilityHandoff(), undefined);
});
