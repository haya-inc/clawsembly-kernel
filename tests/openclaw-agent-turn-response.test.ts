import assert from "node:assert/strict";
import test from "node:test";
import {
  isCompletedAgentTurnResponse,
  isCompletedWorkspaceToolTurnResponse
} from "../src/openclaw-agent-turn-response.ts";

const marker = "CLAWSEMBLY_AGENT_TURN_OK";

function completedResponse(): Record<string, unknown> {
  return {
    runId: "run-1",
    status: "ok",
    summary: "completed",
    result: {
      payloads: [{ text: marker, mediaUrl: null }],
      meta: {
        aborted: false,
        finalPromptText: `Reply exactly: ${marker}`,
        finalAssistantVisibleText: marker,
        finalAssistantRawText: marker,
        replayInvalid: false,
        stopReason: "stop",
        executionTrace: {
          attempts: [{
            provider: "fixture",
            model: "proof",
            result: "success",
            stage: "assistant"
          }],
          fallbackUsed: false,
          runner: "embedded"
        }
      }
    }
  };
}

test("accepts a completed, non-fallback assistant payload", () => {
  assert.equal(isCompletedAgentTurnResponse(completedResponse(), marker), true);
});

test("rejects a timeout that only echoes the marker in prompt metadata", () => {
  const response = completedResponse();
  response.status = "timeout";
  response.summary = "aborted";
  response.result = {
    payloads: [{
      text: "Request timed out before a response was generated."
    }],
    meta: {
      aborted: true,
      finalPromptText: `Reply exactly: ${marker}`,
      replayInvalid: false,
      timeoutPhase: "provider"
    }
  };
  assert.equal(isCompletedAgentTurnResponse(response, marker), false);
});

test("rejects marker text in a failed or aborted result", () => {
  for (const mutation of [
    (response: Record<string, unknown>) => {
      response.status = "error";
    },
    (response: Record<string, unknown>) => {
      const result = response.result as Record<string, unknown>;
      const meta = result.meta as Record<string, unknown>;
      meta.aborted = true;
    },
    (response: Record<string, unknown>) => {
      const result = response.result as Record<string, unknown>;
      const meta = result.meta as Record<string, unknown>;
      const trace = meta.executionTrace as Record<string, unknown>;
      trace.fallbackUsed = true;
    }
  ]) {
    const response = completedResponse();
    mutation(response);
    assert.equal(isCompletedAgentTurnResponse(response, marker), false);
  }
});

test("rejects marker substrings and marker text outside assistant fields", () => {
  const response = completedResponse();
  const result = response.result as Record<string, unknown>;
  const meta = result.meta as Record<string, unknown>;
  result.payloads = [{ text: `prefix ${marker} suffix` }];
  meta.finalAssistantVisibleText = `prefix ${marker} suffix`;
  meta.finalAssistantRawText = `prefix ${marker} suffix`;
  assert.equal(isCompletedAgentTurnResponse(response, marker), false);

  result.payloads = [{ text: "provider error" }];
  meta.finalPromptText = `Reply exactly: ${marker}`;
  assert.equal(isCompletedAgentTurnResponse(response, marker), false);
});

function completedWorkspaceResponse(): Record<string, unknown> {
  const response = completedResponse();
  const result = response.result as Record<string, unknown>;
  const meta = result.meta as Record<string, unknown>;
  result.payloads = [
    { text: "CLAWSEMBLY_WORKSPACE_TOOL_OK" },
    {
      text: "⚠️ Write: `to /openclaw/.clawsembly-outside.txt` failed"
    }
  ];
  meta.finalAssistantVisibleText = "CLAWSEMBLY_WORKSPACE_TOOL_OK";
  meta.finalAssistantRawText = "CLAWSEMBLY_WORKSPACE_TOOL_OK";
  meta.replayInvalid = true;
  meta.toolSummary = {
    calls: 3,
    tools: ["write", "read"],
    failures: 1
  };
  return response;
}

test("accepts the exact workspace tool proof and expected denial", () => {
  const response = completedWorkspaceResponse();
  assert.equal(
    isCompletedWorkspaceToolTurnResponse(
      response,
      "CLAWSEMBLY_WORKSPACE_TOOL_OK"
    ),
    true
  );
  assert.equal(
    isCompletedAgentTurnResponse(response, "CLAWSEMBLY_WORKSPACE_TOOL_OK"),
    false
  );
});

test("rejects workspace responses without the exact denied tool call", () => {
  for (const mutation of [
    (response: Record<string, unknown>) => {
      const result = response.result as Record<string, unknown>;
      result.payloads = [
        { text: "CLAWSEMBLY_WORKSPACE_TOOL_OK" },
        { text: "unrelated warning" }
      ];
    },
    (response: Record<string, unknown>) => {
      const result = response.result as Record<string, unknown>;
      const meta = result.meta as Record<string, unknown>;
      const toolSummary = meta.toolSummary as Record<string, unknown>;
      toolSummary.calls = 2;
    },
    (response: Record<string, unknown>) => {
      const result = response.result as Record<string, unknown>;
      const meta = result.meta as Record<string, unknown>;
      meta.replayInvalid = false;
    }
  ]) {
    const response = completedWorkspaceResponse();
    mutation(response);
    assert.equal(
      isCompletedWorkspaceToolTurnResponse(
        response,
        "CLAWSEMBLY_WORKSPACE_TOOL_OK"
      ),
      false
    );
  }
});
