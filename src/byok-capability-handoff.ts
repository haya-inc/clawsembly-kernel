export type ByokCapabilityHandoff = Readonly<{
  apiKey: string;
  baseUrl: string;
  expiresAt: string;
  model: string;
  providerId: "clawsembly-byok";
}>;

const handoffKey = "__CLAWSEMBLY_BYOK_MODEL_CAPABILITY__";

function handoffGlobal(): Record<string, unknown> {
  return globalThis as unknown as Record<string, unknown>;
}

export function isSecureByokBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      || (
        url.protocol === "http:"
        && (
          url.hostname === "localhost"
          || url.hostname === "127.0.0.1"
          || url.hostname === "[::1]"
        )
      );
  } catch {
    return false;
  }
}

export function stageByokCapabilityHandoff(
  capability: ByokCapabilityHandoff
): void {
  handoffGlobal()[handoffKey] = Object.freeze({ ...capability });
}

export function consumeByokCapabilityHandoff(
): ByokCapabilityHandoff | undefined {
  const target = handoffGlobal();
  const value = target[handoffKey];
  delete target[handoffKey];
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
  ) {
    return undefined;
  }
  const candidate = value as Partial<ByokCapabilityHandoff>;
  if (
    candidate.providerId !== "clawsembly-byok"
    || typeof candidate.apiKey !== "string"
    || candidate.apiKey.length === 0
    || typeof candidate.baseUrl !== "string"
    || !isSecureByokBaseUrl(candidate.baseUrl)
    || typeof candidate.expiresAt !== "string"
    || typeof candidate.model !== "string"
    || candidate.model.length === 0
  ) {
    return undefined;
  }
  return Object.freeze({
    apiKey: candidate.apiKey,
    baseUrl: candidate.baseUrl,
    expiresAt: candidate.expiresAt,
    model: candidate.model,
    providerId: candidate.providerId
  });
}

export function clearByokCapabilityHandoff(): void {
  delete handoffGlobal()[handoffKey];
}
