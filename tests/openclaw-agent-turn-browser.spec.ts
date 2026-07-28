import { expect, test } from "@playwright/test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import path from "node:path";

type FixtureRequest = {
  authorizationMatches: boolean;
  bodySha256: string;
  inputContainsInstruction: boolean;
  messageCount: number;
  messageRoles: string[];
  method: string;
  model: unknown;
  path: string;
  stream: unknown;
  toolMessageCount: number;
  toolMessagesContainPersistedContent: boolean;
  toolMessagesContainWorkspaceDenial: boolean;
  toolNames: string[];
  workspaceTurn: boolean;
};

type AgentTurnEvidence = {
  claim: string;
  client: {
    args: string[];
    distinctGuestProcess: boolean;
    health?: unknown;
    result: {
      stderr: string;
      stdout: string;
    };
  };
  gateway: {
    state: string;
    stdout: string;
  };
  installLifecycle: {
    packageFiles: {
      mutated: boolean;
    };
    requiredEffects: {
      packageStateDatabase: {
        hostContractVersion: string;
        indexedPlugins: number;
      };
    };
    status: string;
  };
  launchHarness: {
    openclawPackageFilesMutated: boolean;
  };
  network: {
    externalEgress: {
      allow: Array<{
        allowPrivateNetwork: boolean;
        host: string;
        port: number;
      }>;
      credentialTransport: string;
      tokenRecorded: boolean;
      transport: string;
    };
    namespace: string;
    url: string;
  };
  notNorthStarCompletion: string;
  providerFixture: {
    api: string;
    baseUrl: string;
    expectedMarker: string;
    model: string;
  };
  schemaVersion: number;
  status: string;
};

const edgeArtifactPath = process.env.CLAWSEMBLY_EDGE_WASIX;
const imagePath = process.env.CLAWSEMBLY_OPENCLAW_IMAGE;
const relayPath = process.env.CLAWSEMBLY_NETWORK_RELAY;
const relayToken = "clawsembly-openclaw-agent-turn-proof";
const fixturePort = 18_794;
const relayPort = 18_792;
const responseMarker = "CLAWSEMBLY_AGENT_TURN_OK";
const workspaceResponseMarker = "CLAWSEMBLY_WORKSPACE_TOOL_OK";
const workspacePersistedContent = "CLAWSEMBLY_WORKSPACE_PERSISTED";
const workspacePrompt =
  "Use the write tool to create clawsembly-proof.txt with exactly "
  + `${workspacePersistedContent}. Then use the read tool to verify it. `
  + "Next, deliberately try the write tool once on the absolute path "
  + "/openclaw/.clawsembly-outside.txt with the text MUST_NOT_EXIST and "
  + "observe that workspace-only policy rejects it. Only after all three "
  + "tool calls, reply with exactly "
  + `<answer>${workspaceResponseMarker}</answer> and nothing else.`;
const agentTurnPrompt =
  "A human is waiting for a visible answer. Reply with exactly the text "
  + "between the tags and nothing else: <answer>"
  + responseMarker
  + "</answer>";
const runtimeDebug = process.env.CLAWSEMBLY_WASMER_DEBUG === "1";
const proofTimeoutMs = Number(
  process.env.CLAWSEMBLY_OPENCLAW_AGENT_TURN_TIMEOUT_MS ?? "240000"
);

test("unmodified OpenClaw completes an agent turn through capability egress", async ({
  page
}, testInfo) => {
  test.skip(
    process.env.CLAWSEMBLY_OPENCLAW_AGENT_TURN_PROOF !== "1"
      || edgeArtifactPath === undefined
      || !existsSync(edgeArtifactPath)
      || imagePath === undefined
      || !existsSync(imagePath)
      || relayPath === undefined
      || !existsSync(relayPath),
    "Set the agent-turn flag, runtime artifacts, package image, and relay"
  );
  test.setTimeout((proofTimeoutMs * 2) + 180_000);

  const requests: FixtureRequest[] = [];
  const fixture = await startFixture(requests);
  let relay: ChildProcessWithoutNullStreams | undefined;
  try {
    relay = await startRelay(path.resolve(relayPath!));
    await page.route((url) => url.pathname === "/edgejs.wasm", async (route) => {
      await route.fulfill({
        contentType: "application/wasm",
        path: path.resolve(edgeArtifactPath!)
      });
    });
    page.on("console", (message) => {
      if (
        (runtimeDebug
          && /wasmer_js::(?:run|tasks|net)|CLAWSEMBLY/iu.test(message.text()))
        ||
        /getaddrinfo|permission|denied|connect_tcp/iu.test(
          message.text()
        )
      ) {
        console.log(`[browser:${message.type()}] ${message.text()}`);
      }
    });
    const pageError = page.waitForEvent("pageerror");
    await page.goto(
      "/openclaw-agent-turn-probe.html"
      + "?artifact=/edgejs.wasm"
      + "&image=/openclaw.clawfs"
      + "&proof=agent-turn"
      + "&relay=ws%3A%2F%2F127.0.0.1%3A18792%2Fv1%2Fnetwork"
      + `&token=${encodeURIComponent(relayToken)}`
      + (process.env.CLAWSEMBLY_OPENCLAW_ERROR_DETAIL === "1"
        ? "&errorDetail=1"
        : "")
      + (runtimeDebug ? "&debug=trace" : "")
      + `&timeoutMs=${proofTimeoutMs}`
    );
    const status = page.locator("#status");
    const outcome = await Promise.race([
      expect.poll(
        () => status.getAttribute("data-state"),
        { timeout: proofTimeoutMs + 60_000 }
      ).toMatch(/^(?:pass|fail)$/u).then(() => ({ kind: "status" as const })),
      pageError.then((error) => ({ error, kind: "pageerror" as const }))
    ]);
    if (outcome.kind === "pageerror") throw outcome.error;
    const resultText = await page.locator("#result").innerText();
    const parsedResult = JSON.parse(resultText) as unknown;
    const persistedEvidence = {
      ...(parsedResult !== null
        && typeof parsedResult === "object"
        && !Array.isArray(parsedResult)
        ? parsedResult
        : { result: parsedResult }),
      providerFixtureHost: {
        implementation: "deterministic OpenAI-compatible SSE fixture",
        interChunkDelayMs: 75,
        streamDelivery: [
          "headers",
          "assistant",
          "finish",
          "done",
          "eof"
        ],
        requests
      }
    };
    writeFileSync(
      testInfo.outputPath("openclaw-agent-turn-browser-evidence.json"),
      `${JSON.stringify(persistedEvidence, null, 2)}\n`
    );
    await testInfo.attach("openclaw-agent-turn-browser-evidence", {
      body: Buffer.from(JSON.stringify(persistedEvidence, null, 2)),
      contentType: "application/json"
    });
    if (await status.getAttribute("data-state") === "fail") {
      throw new Error(resultText);
    }

    const evidence = parsedResult as AgentTurnEvidence;
    expect(evidence).toMatchObject({
      schemaVersion: 1,
      status: "agent-turn-pass",
      providerFixture: {
        api: "openai-completions",
        baseUrl: "http://localhost:18794/v1",
        expectedMarker: responseMarker,
        model: "clawsembly/clawsembly-proof"
      },
      network: {
        namespace: "browser-local-loopback+capability-egress",
        url: "ws://127.0.0.1:18789",
        externalEgress: {
          transport: "self-hosted-virtual-net-websocket-relay",
          credentialTransport: "Sec-WebSocket-Protocol",
          tokenRecorded: false,
          allow: [{
            host: "localhost",
            port: fixturePort,
            allowPrivateNetwork: true
          }]
        }
      },
      installLifecycle: {
        status: "pass",
        packageFiles: {
          mutated: false
        },
        requiredEffects: {
          packageStateDatabase: {
            hostContractVersion: "2026.7.1-2",
            indexedPlugins: 33
          }
        }
      },
      client: {
        args: [
          "agent",
          "--agent",
          "main",
          "--message",
          agentTurnPrompt,
          "--thinking",
          "off",
          "--timeout",
          "120",
          "--json"
        ],
        distinctGuestProcess: true
      },
      launchHarness: {
        openclawPackageFilesMutated: false
      }
    });
    expect(evidence.claim).toContain("real agent turn");
    expect(evidence.client.result.stdout).toContain(responseMarker);
    expect(evidence.client.result.stdout).not.toContain(
      "\"transport\":\"embedded\""
    );
    expect(evidence.client.result.stdout).not.toContain("fallbackFrom");
    expect(evidence.gateway.stdout).toContain("[ws] ← req agent");
    expect(evidence.gateway.stdout).toContain("[ws] → res ✓ agent");
    expect([
      "running-at-agent-turn-proof",
      "exited-after-agent-turn-output"
    ]).toContain(evidence.gateway.state);
    expect(evidence.notNorthStarCompletion).toContain(
      "deterministic OpenAI-compatible fixture"
    );
    expect(evidence.notNorthStarCompletion).not.toContain("relabeled");

    const completionRequest = requests.find(
      (request) =>
        request.path === "/v1/chat/completions"
        && request.inputContainsInstruction
    );
    expect(completionRequest).toMatchObject({
      authorizationMatches: true,
      inputContainsInstruction: true,
      method: "POST",
      model: "clawsembly-proof",
      path: "/v1/chat/completions",
      stream: true
    });
    expect(completionRequest?.messageCount).toBeGreaterThanOrEqual(2);
    expect(completionRequest?.messageRoles).toContain("system");
    expect(completionRequest?.messageRoles).toContain("user");

    const workspaceRequestStart = requests.length;
    const workspacePageError = page.waitForEvent("pageerror");
    await page.goto(
      "/openclaw-agent-turn-probe.html"
      + "?artifact=/edgejs.wasm"
      + "&image=/openclaw.clawfs"
      + "&proof=workspace-tool-turn"
      + "&relay=ws%3A%2F%2F127.0.0.1%3A18792%2Fv1%2Fnetwork"
      + `&token=${encodeURIComponent(relayToken)}`
      + (runtimeDebug ? "&debug=trace" : "")
      + `&timeoutMs=${proofTimeoutMs}`
    );
    const workspaceStatus = page.locator("#status");
    const workspaceOutcome = await Promise.race([
      expect.poll(
        () => workspaceStatus.getAttribute("data-state"),
        { timeout: proofTimeoutMs + 60_000 }
      ).toMatch(/^(?:pass|fail)$/u).then(
        () => ({ kind: "status" as const })
      ),
      workspacePageError.then(
        (error) => ({ error, kind: "pageerror" as const })
      )
    ]);
    if (workspaceOutcome.kind === "pageerror") {
      throw workspaceOutcome.error;
    }
    const workspaceResultText = await page.locator("#result").innerText();
    if (await workspaceStatus.getAttribute("data-state") === "fail") {
      throw new Error(workspaceResultText);
    }
    const workspaceResult = JSON.parse(workspaceResultText) as {
      claim: string;
      client: {
        args: string[];
        result: {
          stdout: string;
        };
      };
      providerFixture: {
        expectedMarker: string;
        mode: string;
      };
      schemaVersion: number;
      status: string;
      workspaceTool: {
        allowedTools: string[];
        commit: {
          files: number;
          generationId: string;
          status: string;
          storeId: string;
        };
        file: {
          expectedContent: string;
          path: string;
          restoredContentMatches: boolean;
        };
        outsideWorkspace: {
          attemptedPath: string;
          existsAfterTurn: boolean;
          policy: string;
        };
        restore: {
          files: number;
          generationId: string;
          status: string;
          storeId: string;
          verification: string;
        };
      };
    };
    const workspaceScenarioRequests = requests.slice(workspaceRequestStart);
    const workspaceRequests = workspaceScenarioRequests.filter(
      (request) => request.workspaceTurn
    );
    const workspaceEvidence = {
      ...workspaceResult,
      providerFixtureHost: {
        implementation:
          "deterministic OpenAI-compatible multi-step tool-call fixture",
        unrelatedBackgroundRequests:
          workspaceScenarioRequests.length - workspaceRequests.length,
        requests: workspaceRequests
      }
    };
    writeFileSync(
      testInfo.outputPath(
        "openclaw-workspace-tool-turn-browser-evidence.json"
      ),
      `${JSON.stringify(workspaceEvidence, null, 2)}\n`
    );
    await testInfo.attach("openclaw-workspace-tool-turn-browser-evidence", {
      body: Buffer.from(JSON.stringify(workspaceEvidence, null, 2)),
      contentType: "application/json"
    });

    expect(workspaceResult).toMatchObject({
      schemaVersion: 1,
      status: "workspace-tool-turn-pass",
      providerFixture: {
        expectedMarker: workspaceResponseMarker,
        mode: "write-read-outside-rejection"
      },
      workspaceTool: {
        allowedTools: ["read", "write"],
        file: {
          expectedContent: workspacePersistedContent,
          path:
            "/openclaw/.clawsembly-gateway-workspace/clawsembly-proof.txt",
          restoredContentMatches: true
        },
        outsideWorkspace: {
          attemptedPath: "/openclaw/.clawsembly-outside.txt",
          existsAfterTurn: false,
          policy: "workspace-only"
        },
        commit: {
          files: 1,
          status: "committed",
          storeId: "openclaw-workspace-tool-turn"
        },
        restore: {
          files: 1,
          status: "restored",
          storeId: "openclaw-workspace-tool-turn",
          verification: "manifest-and-every-file-sha256"
        }
      }
    });
    expect(workspaceResult.workspaceTool.commit.generationId).toBe(
      workspaceResult.workspaceTool.restore.generationId
    );
    expect(workspaceResult.client.args).toEqual([
      "agent",
      "--agent",
      "main",
      "--message",
      workspacePrompt,
      "--thinking",
      "off",
      "--timeout",
      "120",
      "--json"
    ]);
    expect(workspaceResult.client.result.stdout).toContain(
      workspaceResponseMarker
    );
    expect(workspaceResult.claim).toContain("real write and read tools");
    expect(workspaceRequests).toHaveLength(4);
    expect(workspaceRequests.map((request) => request.toolMessageCount))
      .toEqual([0, 1, 2, 3]);
    expect(workspaceRequests.every(
      (request) => request.authorizationMatches
    )).toBe(true);
    expect(workspaceRequests[0]?.toolNames).toEqual(
      expect.arrayContaining(["read", "write"])
    );
    expect(
      workspaceRequests[2]?.toolMessagesContainPersistedContent
    ).toBe(true);
    expect(
      workspaceRequests[3]?.toolMessagesContainWorkspaceDenial
    ).toBe(true);
  } finally {
    relay?.kill("SIGTERM");
    fixture.closeAllConnections();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  }
});

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function handleFixtureRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requests: FixtureRequest[]
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "GET" && requestUrl.pathname === "/v1/models") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      data: [{
        id: "clawsembly-proof",
        object: "model",
        owned_by: "clawsembly"
      }],
      object: "list"
    }));
    return;
  }
  if (
    request.method !== "POST"
    || requestUrl.pathname !== "/v1/chat/completions"
  ) {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: "not found" } }));
    return;
  }

  const body = await readJsonBody(request) as {
    messages?: Array<{ content?: unknown; role?: unknown }>;
    model?: unknown;
    stream?: unknown;
    tools?: Array<{
      function?: {
        name?: unknown;
      };
    }>;
  };
  const serializedBody = JSON.stringify(body);
  const workspaceTurn = serializedBody.includes(workspacePrompt);
  const toolMessageCount = (body.messages ?? []).filter(
    (message) => message.role === "tool"
  ).length;
  const serializedToolMessages = JSON.stringify(
    (body.messages ?? []).filter((message) => message.role === "tool")
  );
  requests.push({
    authorizationMatches:
      request.headers.authorization === "Bearer clawsembly-fixture-key",
    bodySha256: createHash("sha256").update(serializedBody).digest("hex"),
    inputContainsInstruction: serializedBody.includes(
      agentTurnPrompt
    ),
    messageCount: body.messages?.length ?? 0,
    messageRoles: (body.messages ?? [])
      .map((message) => String(message.role ?? "")),
    method: request.method,
    model: body.model,
    path: requestUrl.pathname,
    stream: body.stream,
    toolMessageCount,
    toolMessagesContainPersistedContent:
      serializedToolMessages.includes(workspacePersistedContent),
    toolMessagesContainWorkspaceDenial:
      /outside|workspace|denied|not allowed|must be within/iu.test(
        serializedToolMessages
      ),
    toolNames: (body.tools ?? []).map(
      (tool) => String(tool.function?.name ?? "")
    ),
    workspaceTurn
  });

  if (body.stream === true) {
    response.writeHead(200, {
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream"
    });
    response.flushHeaders();
    const created = 1_785_134_400;
    let delta: Record<string, unknown>;
    let finishReason: "stop" | "tool_calls";
    if (workspaceTurn && toolMessageCount < 3) {
      const toolCall = toolMessageCount === 0
        ? {
            id: "call_clawsembly_write_workspace",
            name: "write",
            arguments: {
              path: "clawsembly-proof.txt",
              content: workspacePersistedContent
            }
          }
        : toolMessageCount === 1
          ? {
              id: "call_clawsembly_read_workspace",
              name: "read",
              arguments: {
                path: "clawsembly-proof.txt"
              }
            }
          : {
              id: "call_clawsembly_write_outside",
              name: "write",
              arguments: {
                path: "/openclaw/.clawsembly-outside.txt",
                content: "MUST_NOT_EXIST"
              }
            };
      delta = {
        role: "assistant",
        tool_calls: [{
          index: 0,
          id: toolCall.id,
          type: "function",
          function: {
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.arguments)
          }
        }]
      };
      finishReason = "tool_calls";
    } else {
      const content = workspaceTurn
        ? workspaceResponseMarker
        : serializedBody.includes(agentTurnPrompt)
          ? responseMarker
          : "CLAWSEMBLY_BACKGROUND_TURN_IGNORED";
      delta = {
        role: "assistant",
        content
      };
      finishReason = "stop";
    }
    await delay(75);
    response.write(`data: ${JSON.stringify({
      id: "chatcmpl-clawsembly-proof",
      object: "chat.completion.chunk",
      created,
      model: "clawsembly-proof",
      choices: [{
        index: 0,
        delta,
        finish_reason: null
      }]
    })}\n\n`);
    await delay(75);
    response.write(`data: ${JSON.stringify({
      id: "chatcmpl-clawsembly-proof",
      object: "chat.completion.chunk",
      created,
      model: "clawsembly-proof",
      choices: [{
        index: 0,
        delta: {},
        finish_reason: finishReason
      }],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2
      }
    })}\n\n`);
    await delay(75);
    response.write("data: [DONE]\n\n");
    await delay(75);
    response.end();
    return;
  }

  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({
    id: "chatcmpl-clawsembly-proof",
    object: "chat.completion",
    created: 1_785_134_400,
    model: "clawsembly-proof",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: serializedBody.includes(agentTurnPrompt)
          ? responseMarker
          : "CLAWSEMBLY_BACKGROUND_TURN_IGNORED"
      },
      finish_reason: "stop"
    }],
    usage: {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2
    }
  }));
}

async function startFixture(requests: FixtureRequest[]): Promise<Server> {
  const fixture = createServer((request, response) => {
    void handleFixtureRequest(request, response, requests).catch((error) => {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        error: {
          message: error instanceof Error ? error.message : String(error)
        }
      }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    fixture.once("error", reject);
    fixture.listen({ host: "::", port: fixturePort, ipv6Only: false }, () => {
      fixture.off("error", reject);
      resolve();
    });
  });
  return fixture;
}

async function startRelay(
  executable: string
): Promise<ChildProcessWithoutNullStreams> {
  const relay = spawn(executable, [
    "--listen",
    `127.0.0.1:${relayPort}`,
    "--allow",
    `localhost:${fixturePort}`,
    "--allow-private-network"
  ], {
    env: {
      ...process.env,
      CLAWSEMBLY_NETWORK_RELAY_TOKEN: relayToken
    },
    stdio: "pipe"
  });
  let stdout = "";
  let stderr = "";
  relay.stdout.setEncoding("utf8");
  relay.stderr.setEncoding("utf8");
  relay.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    console.log(`[relay:stdout] ${chunk.trimEnd()}`);
  });
  relay.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    console.log(`[relay:stderr] ${chunk.trimEnd()}`);
  });
  await Promise.race([
    new Promise<void>((resolve, reject) => {
      const interval = setInterval(() => {
        if (stdout.includes("\"status\":\"ready\"")) {
          clearInterval(interval);
          resolve();
        }
      }, 10);
      relay.once("exit", (code) => {
        clearInterval(interval);
        reject(
          new Error(
            `network relay exited before readiness (${code}): ${stderr || stdout}`
          )
        );
      });
    }),
    new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`network relay readiness timeout: ${stderr}`)),
        10_000
      );
    })
  ]);
  return relay;
}
