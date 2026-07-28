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

export type CompletedWorkspaceToolTurnResponse = {
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
      replayInvalid: true;
      stopReason: "stop";
      toolSummary: {
        calls: 3;
        failures: 1;
        tools: string[];
      };
    };
    payloads: Array<{
      text: string;
    }>;
  };
  runId: string;
  status: "ok";
  summary: "completed";
};

const workspaceDeniedWriteTexts = new Set([
  "⚠️ Write: `to /openclaw/.clawsembly-outside.txt` failed",
  "⚠️ ✍️ Write: `to /openclaw/.clawsembly-outside.txt (14 chars)` failed"
]);

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value);
}

function isExactText(value: unknown, expectedText: string): value is string {
  return typeof value === "string" && value.trim() === expectedText;
}

function isWorkspaceDeniedWriteText(value: unknown): value is string {
  return typeof value === "string"
    && workspaceDeniedWriteTexts.has(value.trim());
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

/**
 * Validate the workspace proof's intentionally different response shape.
 * OpenClaw appends one warning payload and marks the replay invalid when the
 * deliberately forbidden write fails. Treating that expected warning as a
 * normal assistant response would weaken the ordinary agent-turn contract, so
 * this validator accepts only the exact marker plus one of the two exact
 * official renderings observed from OpenClaw's plain and decorated reporters.
 */
export function isCompletedWorkspaceToolTurnResponse(
  value: unknown,
  expectedText: string
): value is CompletedWorkspaceToolTurnResponse {
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
    || payloads.length !== 2
    || !payloads.every(isJsonRecord)
    || payloads.filter(
      (payload) => isExactText(payload.text, expectedText)
    ).length !== 1
    || payloads.filter(
      (payload) => isWorkspaceDeniedWriteText(payload.text)
    ).length !== 1
    || !isJsonRecord(meta)
    || meta.aborted !== false
    || meta.replayInvalid !== true
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
    || !isJsonRecord(meta.toolSummary)
    || meta.toolSummary.calls !== 3
    || meta.toolSummary.failures !== 1
    || !Array.isArray(meta.toolSummary.tools)
    || meta.toolSummary.tools.length !== 2
    || !meta.toolSummary.tools.every(
      (tool) => tool === "read" || tool === "write"
    )
    || !meta.toolSummary.tools.includes("read")
    || !meta.toolSummary.tools.includes("write")
  ) {
    return false;
  }

  return true;
}
