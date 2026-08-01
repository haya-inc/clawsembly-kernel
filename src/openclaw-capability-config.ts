import type { ByokCapabilityHandoff } from "./byok-capability-handoff";

export type OpenClawCapabilityConfigSummary = Readonly<{
  model: string;
  modelApi: ByokCapabilityHandoff["modelApi"];
  primaryModel: string;
  providerId: ByokCapabilityHandoff["openClawProvider"];
}>;

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

export function createOpenClawCapabilityPatch(
  capability: ByokCapabilityHandoff
): {
  patch: JsonRecord;
  summary: OpenClawCapabilityConfigSummary;
} {
  const providerId = capability.openClawProvider;
  const primaryModel = `${providerId}/${capability.model}`;
  return {
    patch: {
      agents: {
        defaults: {
          model: {
            primary: primaryModel
          }
        }
      },
      models: {
        providers: {
          [providerId]: {
            api: capability.modelApi,
            apiKey: capability.apiKey,
            baseUrl: "http://localhost:18794/v1",
            models: [{
              id: capability.model,
              name: capability.modelApi === "openai-chatgpt-responses"
                ? "OpenAI ChatGPT"
                : capability.model,
              reasoning:
                capability.modelApi === "openai-chatgpt-responses",
              input: ["text", "image"],
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0
              },
              contextWindow:
                capability.modelApi === "openai-chatgpt-responses"
                  ? 200_000
                  : 128_000,
              maxTokens: 16_384
            }]
          }
        }
      }
    },
    summary: {
      model: capability.model,
      modelApi: capability.modelApi,
      primaryModel,
      providerId
    }
  };
}

export function hasOpenClawCapabilityConfig(
  raw: string,
  summary: OpenClawCapabilityConfigSummary,
  expectedApiKey: string
): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  const root = asRecord(parsed);
  const defaults = asRecord(asRecord(root.agents).defaults);
  const model = asRecord(defaults.model);
  const providers = asRecord(asRecord(root.models).providers);
  const provider = asRecord(providers[summary.providerId]);
  const models = Array.isArray(provider.models)
    ? provider.models
    : [];
  return model.primary === summary.primaryModel
    && provider.api === summary.modelApi
    && provider.apiKey === expectedApiKey
    && provider.baseUrl === "http://localhost:18794/v1"
    && models.some((candidate) =>
      asRecord(candidate).id === summary.model);
}
