type JsonRecord = Record<string, unknown>;

export type CompletedAgentTurnResponse = {
  result: {
    meta: {
      aborted: false;
      executionTrace: {
        attempts: Array<{
          result: "success";
          stage: "assistant";
        }>;
        fallbackUsed: false;
      };
      finalAssistantRawText: string;
      finalAssistantVisibleText: string;
      replayInvalid: false;
      stopReason: "stop";
    };
    payloads: Array<{
      text: string;
    }>;
  };
  runId: string;
  status: "ok";
  summary: "completed";
};

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value);
}

function isExactText(value: unknown, expectedText: string): value is string {
  return typeof value === "string" && value.trim() === expectedText;
}

/**
 * Accept only an actual, completed assistant response from the official
 * OpenClaw agent JSON contract. In particular, never search arbitrary
 * metadata: the request is also retained as `finalPromptText`, so a recursive
 * marker search can mistake a timeout or provider failure for a model reply.
 */
export function isCompletedAgentTurnResponse(
  value: unknown,
  expectedText: string
): value is CompletedAgentTurnResponse {
  if (
    expectedText.length === 0
    || !isJsonRecord(value)
    || typeof value.runId !== "string"
    || value.runId.length === 0
    || value.status !== "ok"
    || value.summary !== "completed"
    || !isJsonRecord(value.result)
  ) {
    return false;
  }

  const payloads = value.result.payloads;
  const meta = value.result.meta;
  if (
    !Array.isArray(payloads)
    || !payloads.some(
      (payload) =>
        isJsonRecord(payload)
        && isExactText(payload.text, expectedText)
    )
    || !isJsonRecord(meta)
    || meta.aborted !== false
    || meta.replayInvalid !== false
    || meta.stopReason !== "stop"
    || !isExactText(meta.finalAssistantVisibleText, expectedText)
    || !isExactText(meta.finalAssistantRawText, expectedText)
    || !isJsonRecord(meta.executionTrace)
    || meta.executionTrace.fallbackUsed !== false
    || !Array.isArray(meta.executionTrace.attempts)
    || !meta.executionTrace.attempts.some(
      (attempt) =>
        isJsonRecord(attempt)
        && attempt.result === "success"
        && attempt.stage === "assistant"
    )
  ) {
    return false;
  }

  return true;
}
