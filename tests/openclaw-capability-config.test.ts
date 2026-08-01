import assert from "node:assert/strict";
import test from "node:test";
import {
  createOpenClawCapabilityPatch,
  hasOpenClawCapabilityConfig
} from "../src/openclaw-capability-config.ts";

test("builds the OpenAI OAuth capability provider without a bearer token", () => {
  const capability = {
    apiKey: "opaque-guest-capability",
    apiPath: "/v1/responses" as const,
    baseUrl: "https://clawsembly.yhay81.com/api/byok/v1",
    expiresAt: "2026-07-30T01:00:00.000Z",
    modelApi: "openai-chatgpt-responses" as const,
    model: "gpt-5.6-sol",
    openClawProvider: "openai" as const,
    providerId: "clawsembly-byok" as const
  };
  const { patch, summary } = createOpenClawCapabilityPatch(capability);

  assert.deepEqual(summary, {
    model: "gpt-5.6-sol",
    modelApi: "openai-chatgpt-responses",
    primaryModel: "openai/gpt-5.6-sol",
    providerId: "openai"
  });
  assert.equal(
    (
      patch.models as {
        providers: { openai: { apiKey: string; baseUrl: string } };
      }
    ).providers.openai.apiKey,
    "opaque-guest-capability"
  );
  assert.equal(
    (
      patch.models as {
        providers: { openai: { apiKey: string; baseUrl: string } };
      }
    ).providers.openai.baseUrl,
    "http://localhost:18794/v1"
  );
  assert.doesNotMatch(JSON.stringify(patch), /Bearer /u);
});

test("verifies only the committed provider and primary model", () => {
  const { patch, summary } = createOpenClawCapabilityPatch({
    apiKey: "opaque-guest-capability",
    apiPath: "/v1/chat/completions",
    baseUrl: "https://clawsembly.yhay81.com/api/byok/v1",
    expiresAt: "2026-07-30T01:00:00.000Z",
    modelApi: "openai-completions",
    model: "gpt-5.6",
    openClawProvider: "clawsembly-byok",
    providerId: "clawsembly-byok"
  });

  assert.equal(
    hasOpenClawCapabilityConfig(JSON.stringify({
      gateway: { mode: "local" },
      ...patch
    }), summary, "opaque-guest-capability"),
    true
  );
  assert.equal(
    hasOpenClawCapabilityConfig(JSON.stringify(patch).replace(
      "http://localhost:18794/v1",
      "https://example.com/v1"
    ), summary, "opaque-guest-capability"),
    false
  );
  assert.equal(
    hasOpenClawCapabilityConfig(
      JSON.stringify(patch),
      summary,
      "wrong-capability"
    ),
    false
  );
  assert.equal(
    hasOpenClawCapabilityConfig(
      "{bad",
      summary,
      "opaque-guest-capability"
    ),
    false
  );
});
