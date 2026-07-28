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
  test.setTimeout(proofTimeoutMs + 120_000);

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
          `Reply exactly: ${responseMarker}`,
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
      (request) => request.path === "/v1/chat/completions"
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
  };
  const serializedBody = JSON.stringify(body);
  requests.push({
    authorizationMatches:
      request.headers.authorization === "Bearer clawsembly-fixture-key",
    bodySha256: createHash("sha256").update(serializedBody).digest("hex"),
    inputContainsInstruction: serializedBody.includes(
      `Reply exactly: ${responseMarker}`
    ),
    messageCount: body.messages?.length ?? 0,
    messageRoles: (body.messages ?? [])
      .map((message) => String(message.role ?? "")),
    method: request.method,
    model: body.model,
    path: requestUrl.pathname,
    stream: body.stream
  });

  if (body.stream === true) {
    response.writeHead(200, {
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream"
    });
    response.flushHeaders();
    const created = 1_785_134_400;
    await delay(75);
    response.write(`data: ${JSON.stringify({
      id: "chatcmpl-clawsembly-proof",
      object: "chat.completion.chunk",
      created,
      model: "clawsembly-proof",
      choices: [{
        index: 0,
        delta: {
          role: "assistant",
          content: responseMarker
        },
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
        finish_reason: "stop"
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
        content: responseMarker
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
