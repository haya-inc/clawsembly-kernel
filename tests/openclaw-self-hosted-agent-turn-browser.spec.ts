import { expect, test } from "@playwright/test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isCompletedAgentTurnResponse } from
  "../src/openclaw-agent-turn-response";

type JsonRecord = Record<string, unknown>;

type CapturedProcess = {
  child: ChildProcessWithoutNullStreams;
  stderr: () => string;
  stdout: () => string;
};

type SelfHostedAgentTurnEvidence = {
  agentResponseValidation: {
    arbitraryMetadataSearched: boolean;
    contract: string;
    promptEchoesAccepted: boolean;
  };
  artifact: {
    sha256: string;
  };
  claim: string;
  client: {
    args: string[];
    completion: string;
    distinctGuestProcess: boolean;
    health: unknown;
  };
  gateway: {
    state: string;
    stdout: string;
  };
  image: {
    sha256: string;
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
  schemaVersion: number;
  selfHostedModel: {
    api: string;
    browserReceivesModelServiceCredential: boolean;
    capabilityBroker: {
      hostProcess?: {
        ready: JsonRecord;
        upstreamResponse: JsonRecord;
      };
      implementation: string;
      security: {
        exactEndpointAndModel: boolean;
        loopbackOnly: boolean;
        maxConcurrency: number;
        maxRequests: number;
      };
    };
    expectedMarker: string;
    guestEndpoint: string;
    guestOperationCapability: {
      authority: string;
      model: string;
      recorded: boolean;
      streamingRequired: boolean;
    };
    hostProcess?: {
      inferenceRuntime: {
        apiKeyRecorded: boolean;
        binarySha256: string;
        distributionSha256: string;
        health: JsonRecord;
        modelList: JsonRecord;
        release: string;
        sourceCommit: string;
      };
      model: {
        bytes: number;
        sha256: string;
      };
    };
    model: string;
    runtime: {
      authentication: {
        credential: string;
        recorded: boolean;
        visibleToGuest: boolean;
      };
      endpoint: string;
      implementation: string;
      license: string;
      loopbackOnly: boolean;
      model: {
        file: string;
        id: string;
        license: string;
        repository: string;
        revision: string;
        sha256: string;
      };
      transport: string;
    };
  };
  status: string;
};

const edgeArtifactPath = process.env.CLAWSEMBLY_EDGE_WASIX;
const imagePath = process.env.CLAWSEMBLY_OPENCLAW_IMAGE;
const brokerPath = process.env.CLAWSEMBLY_PROVIDER_BROKER;
const relayPath = process.env.CLAWSEMBLY_NETWORK_RELAY;
const llamaServerPath = process.env.CLAWSEMBLY_LLAMA_SERVER;
const modelPath = process.env.CLAWSEMBLY_SELF_HOSTED_MODEL;
const brokerToken = "clawsembly-one-self-hosted-completion";
const relayToken = "clawsembly-self-hosted-model-network-proof";
const modelServiceApiKey = "clawsembly-host-local-model-service-key";
const brokerPort = 18_794;
const modelPort = 18_795;
const relayPort = 18_792;
const modelId = "qwen2.5-0.5b-instruct";
const responseMarker = "CLAWSEMBLY_AGENT_TURN_OK";
const llamaRelease = "b9637";
const llamaSourceCommit = "aedb2a5e9ca3d4064148bbb919e0ddc0c1b70ab3";
const expectedLlamaBinarySha256 =
  "77eb1229a117e3034b873a46382bffcecc0f9815bd14e825a0706f8fc0b07564";
const llamaDistributionSha256 =
  "a50ee14f021a9d8e92e30f622f7e3be1318ee1125bb9a9ba8d2025388df48743";
const expectedModelSha256 =
  "74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db";
const proofTimeoutMs = Number(
  process.env.CLAWSEMBLY_OPENCLAW_SELF_HOSTED_AGENT_TURN_TIMEOUT_MS
    ?? "300000"
);

test(
  "unmodified OpenClaw completes a turn with a pinned self-hosted OSS model",
  async ({ page }, testInfo) => {
    test.skip(
      process.env.CLAWSEMBLY_OPENCLAW_SELF_HOSTED_AGENT_TURN_PROOF !== "1"
        || edgeArtifactPath === undefined
        || !existsSync(edgeArtifactPath)
        || imagePath === undefined
        || !existsSync(imagePath)
        || brokerPath === undefined
        || !existsSync(brokerPath)
        || relayPath === undefined
        || !existsSync(relayPath)
        || llamaServerPath === undefined
        || !existsSync(llamaServerPath)
        || modelPath === undefined
        || !existsSync(modelPath),
      "Set the self-hosted proof flag and all pinned runtime artifact paths"
    );
    test.setTimeout(proofTimeoutMs + 180_000);

    const [llamaBinarySha256, modelSha256] = await Promise.all([
      sha256File(path.resolve(llamaServerPath!)),
      sha256File(path.resolve(modelPath!))
    ]);
    expect(llamaBinarySha256).toBe(
      process.env.CLAWSEMBLY_LLAMA_SERVER_SHA256
        ?? expectedLlamaBinarySha256
    );
    expect(modelSha256).toBe(expectedModelSha256);

    let modelServer: CapturedProcess | undefined;
    let broker: CapturedProcess | undefined;
    let relay: CapturedProcess | undefined;
    try {
      modelServer = await startModelServer(
        path.resolve(llamaServerPath!),
        path.resolve(modelPath!)
      );
      const health = await fetchJson(`http://127.0.0.1:${modelPort}/health`);
      const modelList = await fetchJson(
        `http://127.0.0.1:${modelPort}/v1/models`,
        modelServiceApiKey
      );
      expect(health).toMatchObject({ status: "ok" });
      expect(modelList).toMatchObject({
        data: [{ id: modelId, owned_by: "llamacpp" }],
        object: "list"
      });

      broker = await startBroker(path.resolve(brokerPath!));
      relay = await startRelay(path.resolve(relayPath!));
      await page.addInitScript((capability) => {
        Object.defineProperty(
          globalThis,
          "__CLAWSEMBLY_SELF_HOSTED_MODEL_CAPABILITY__",
          {
            configurable: true,
            enumerable: false,
            value: capability,
            writable: false
          }
        );
      }, {
        brokerToken,
        relayToken
      });
      await page.route(
        (url) => url.pathname === "/edgejs.wasm",
        async (route) => {
          await route.fulfill({
            contentType: "application/wasm",
            path: path.resolve(edgeArtifactPath!)
          });
        }
      );

      const pageError = page.waitForEvent("pageerror");
      await page.goto(
        "/openclaw-agent-turn-probe.html"
        + "?artifact=/edgejs.wasm"
        + "&image=/openclaw.clawfs"
        + "&proof=self-hosted-agent-turn"
        + "&relay=ws%3A%2F%2F127.0.0.1%3A18792%2Fv1%2Fnetwork"
        + `&timeoutMs=${proofTimeoutMs}`
      );
      const status = page.locator("#status");
      const outcome = await Promise.race([
        expect.poll(
          () => status.getAttribute("data-state"),
          { timeout: proofTimeoutMs + 60_000 }
        ).toMatch(/^(?:pass|fail)$/u).then(
          () => ({ kind: "status" as const })
        ),
        pageError.then(
          (error) => ({ error, kind: "pageerror" as const })
        )
      ]);
      if (outcome.kind === "pageerror") throw outcome.error;
      if (await status.getAttribute("data-state") === "fail") {
        throw new Error(await page.locator("#result").innerText());
      }

      const evidenceText = await page.locator("#result").innerText();
      const processText = [
        modelServer.stdout(),
        modelServer.stderr(),
        broker.stdout(),
        broker.stderr(),
        relay.stdout(),
        relay.stderr()
      ].join("\n");
      for (const secret of [
        modelServiceApiKey,
        brokerToken,
        relayToken
      ]) {
        expect(evidenceText).not.toContain(secret);
        expect(processText).not.toContain(secret);
      }

      const browserEvidence =
        JSON.parse(evidenceText) as SelfHostedAgentTurnEvidence;
      expect(browserEvidence).toMatchObject({
        schemaVersion: 1,
        status: "self-hosted-agent-turn-pass",
        agentResponseValidation: {
          arbitraryMetadataSearched: false,
          contract: "strict-assistant-payload-v1",
          promptEchoesAccepted: false
        },
        selfHostedModel: {
          api: "openai-completions",
          browserReceivesModelServiceCredential: false,
          guestEndpoint: "http://localhost:18794/v1",
          guestOperationCapability: {
            authority:
              "POST http://localhost:18794/v1/chat/completions",
            model: modelId,
            recorded: false,
            streamingRequired: true
          },
          expectedMarker: responseMarker,
          model: `clawsembly-broker/${modelId}`,
          runtime: {
            implementation: "llama.cpp",
            license: "MIT",
            endpoint:
              "http://127.0.0.1:18795/v1/chat/completions",
            loopbackOnly: true,
            model: {
              id: modelId,
              license: "Apache-2.0",
              repository: "Qwen/Qwen2.5-0.5B-Instruct-GGUF",
              revision:
                "d78c9c2baefc6237025b685bb0d6db90288ef3d6",
              file: "qwen2.5-0.5b-instruct-q4_k_m.gguf",
              sha256: expectedModelSha256
            },
            authentication: {
              credential: "host-local llama.cpp API key",
              recorded: false,
              visibleToGuest: false
            },
            transport:
              "explicitly allowed host-loopback HTTP; no external network"
          },
          capabilityBroker: {
            implementation: "clawsembly-provider-broker",
            security: {
              exactEndpointAndModel: true,
              loopbackOnly: true,
              maxConcurrency: 1,
              maxRequests: 1
            }
          }
        },
        network: {
          namespace:
            "browser-local-loopback+self-hosted-model-capability-egress",
          url: "ws://127.0.0.1:18789",
          externalEgress: {
            transport: "self-hosted-virtual-net-websocket-relay",
            credentialTransport: "Sec-WebSocket-Protocol",
            tokenRecorded: false,
            allow: [{
              host: "localhost",
              port: brokerPort,
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
          completion: "agent-turn-output-observed",
          distinctGuestProcess: true
        },
        launchHarness: {
          openclawPackageFilesMutated: false
        }
      });
      expect(browserEvidence.claim).toContain(
        "actual Qwen response from a pinned self-hosted llama.cpp process"
      );
      expect(
        isCompletedAgentTurnResponse(
          browserEvidence.client.health,
          responseMarker
        )
      ).toBe(true);
      expect(browserEvidence.gateway.stdout).toContain("[ws] ← req agent");
      expect(browserEvidence.gateway.stdout).toContain("[ws] → res ✓ agent");
      expect([
        "running-at-agent-turn-proof",
        "exited-after-agent-turn-output"
      ]).toContain(browserEvidence.gateway.state);
      expect(browserEvidence.notNorthStarCompletion).toContain(
        "model-service credential, GGUF weights, and inference process remain outside"
      );

      const brokerRecords = jsonLines(broker.stdout());
      const ready = brokerRecords.find(
        (record) => record.status === "ready"
      );
      const upstreamResponse = brokerRecords.find(
        (record) => record.status === "upstream-response"
      );
      expect(ready).toMatchObject({
        status: "ready",
        listen: `127.0.0.1:${brokerPort}`,
        path: "/v1/chat/completions",
        upstreamAuthority: `127.0.0.1:${modelPort}`,
        upstreamScheme: "http",
        loopbackHttpExplicitlyAllowed: true,
        model: modelId,
        maxRequests: 1,
        maxConcurrency: 1,
        providerCredentialRecorded: false
      });
      expect(upstreamResponse).toMatchObject({
        status: "upstream-response",
        requestId: 1,
        requestNumber: 1,
        httpStatus: 200,
        model: modelId,
        stream: true,
        providerCredentialRecorded: false,
        requestBodyRecorded: false
      });

      const modelBytes = Number(
        process.env.CLAWSEMBLY_SELF_HOSTED_MODEL_BYTES ?? "491400032"
      );
      const evidence: SelfHostedAgentTurnEvidence = {
        ...browserEvidence,
        selfHostedModel: {
          ...browserEvidence.selfHostedModel,
          capabilityBroker: {
            ...browserEvidence.selfHostedModel.capabilityBroker,
            hostProcess: {
              ready: ready!,
              upstreamResponse: upstreamResponse!
            }
          },
          hostProcess: {
            inferenceRuntime: {
              apiKeyRecorded: false,
              binarySha256: llamaBinarySha256,
              distributionSha256: llamaDistributionSha256,
              health,
              modelList,
              release: llamaRelease,
              sourceCommit: llamaSourceCommit
            },
            model: {
              bytes: modelBytes,
              sha256: modelSha256
            }
          }
        }
      };
      const serializedEvidence = `${JSON.stringify(evidence, null, 2)}\n`;
      for (const secret of [
        modelServiceApiKey,
        brokerToken,
        relayToken
      ]) {
        expect(serializedEvidence).not.toContain(secret);
      }
      writeFileSync(
        testInfo.outputPath(
          "openclaw-self-hosted-agent-turn-browser-evidence.json"
        ),
        serializedEvidence
      );
      await testInfo.attach(
        "openclaw-self-hosted-agent-turn-browser-evidence",
        {
          body: Buffer.from(serializedEvidence),
          contentType: "application/json"
        }
      );
    } finally {
      relay?.child.kill("SIGTERM");
      broker?.child.kill("SIGTERM");
      modelServer?.child.kill("SIGTERM");
    }
  }
);

async function startModelServer(
  executable: string,
  model: string
): Promise<CapturedProcess> {
  const process = captureProcess(spawn(executable, [
    "--model",
    model,
    "--alias",
    modelId,
    "--host",
    "127.0.0.1",
    "--port",
    String(modelPort),
    "--ctx-size",
    "32768",
    "--parallel",
    "1",
    "--n-predict",
    "128",
    "--threads",
    "4",
    "--no-webui"
  ], {
    cwd: path.dirname(executable),
    env: {
      LLAMA_API_KEY: modelServiceApiKey
    },
    stdio: "pipe"
  }));
  await waitForHttpReady(
    process,
    `http://127.0.0.1:${modelPort}/health`,
    60_000
  );
  return process;
}

async function startBroker(executable: string): Promise<CapturedProcess> {
  const process = captureProcess(spawn(executable, [
    "--listen",
    `127.0.0.1:${brokerPort}`,
    "--model",
    modelId,
    "--upstream",
    `http://127.0.0.1:${modelPort}/v1/chat/completions`,
    "--allow-loopback-http-upstream",
    "--max-requests",
    "1"
  ], {
    env: {
      CLAWSEMBLY_PROVIDER_API_KEY: modelServiceApiKey,
      CLAWSEMBLY_PROVIDER_BROKER_TOKEN: brokerToken
    },
    stdio: "pipe"
  }));
  await waitForProcessMarker(process, "\"status\":\"ready\"", 10_000);
  return process;
}

async function startRelay(executable: string): Promise<CapturedProcess> {
  const process = captureProcess(spawn(executable, [
    "--listen",
    `127.0.0.1:${relayPort}`,
    "--allow",
    `localhost:${brokerPort}`,
    "--allow-private-network"
  ], {
    env: {
      CLAWSEMBLY_NETWORK_RELAY_TOKEN: relayToken
    },
    stdio: "pipe"
  }));
  await waitForProcessMarker(process, "\"status\":\"ready\"", 10_000);
  return process;
}

function captureProcess(
  child: ChildProcessWithoutNullStreams
): CapturedProcess {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return {
    child,
    stderr: () => stderr,
    stdout: () => stdout
  };
}

async function waitForHttpReady(
  process: CapturedProcess,
  url: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (process.child.exitCode !== null) {
      throw new Error(
        `model server exited before readiness (${process.child.exitCode}): `
          + (process.stderr() || process.stdout())
      );
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The loopback listener is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `model server readiness timeout: ${process.stderr()}`
  );
}

async function fetchJson(
  url: string,
  apiKey?: string
): Promise<JsonRecord> {
  const response = await fetch(url, {
    headers: apiKey
      ? { authorization: `Bearer ${apiKey}` }
      : undefined
  });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return await response.json() as JsonRecord;
}

async function waitForProcessMarker(
  process: CapturedProcess,
  marker: string,
  timeoutMs: number
): Promise<void> {
  await Promise.race([
    new Promise<void>((resolve, reject) => {
      const interval = setInterval(() => {
        if (process.stdout().includes(marker)) {
          clearInterval(interval);
          resolve();
        }
      }, 10);
      process.child.once("exit", (code) => {
        clearInterval(interval);
        reject(
          new Error(
            `process exited before readiness (${code}): `
              + (process.stderr() || process.stdout())
          )
        );
      });
    }),
    new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(
          new Error(`process readiness timeout: ${process.stderr()}`)
        ),
        timeoutMs
      );
    })
  ]);
}

function jsonLines(value: string): JsonRecord[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as JsonRecord);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}
