import { expect, test } from "@playwright/test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isCompletedAgentTurnResponse } from
  "../src/openclaw-agent-turn-response";

type JsonRecord = Record<string, unknown>;

type BrokeredLiveAgentTurnEvidence = {
  agentResponseValidation: {
    arbitraryMetadataSearched: boolean;
    contract: string;
    promptEchoesAccepted: boolean;
  };
  claim: string;
  client: {
    args: string[];
    completion: string;
    distinctGuestProcess: boolean;
    health: unknown;
    result: {
      stderr: string;
      stdout: string;
    };
  };
  credentialBroker: {
    api: string;
    browserReceivesProviderCredential: boolean;
    expectedMarker: string;
    guestEndpoint: string;
    guestOperationCapability: {
      authority: string;
      model: string;
      recorded: boolean;
      streamingRequired: boolean;
    };
    hostProcess?: {
      ready: JsonRecord;
      upstreamResponse: JsonRecord;
    };
    model: string;
    provider: {
      authentication: {
        credential: string;
        recorded: boolean;
        repositoryContentsPermission: string;
        workflowPermissions: string[];
      };
      endpoint: string;
      model: string;
      tls: {
        authority: string;
        terminatedBy: string;
        validation: string;
        visibleToGuest: boolean;
      };
    };
    security: {
      exactEndpointAndModel: boolean;
      loopbackOnly: boolean;
      maxConcurrency: number;
      maxRequestBytes: number;
      maxRequests: number;
      maxResponseBytes: number;
      redirects: string;
      systemProxy: string;
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
  schemaVersion: number;
  status: string;
};

type CapturedProcess = {
  child: ChildProcessWithoutNullStreams;
  stderr: () => string;
  stdout: () => string;
};

const edgeArtifactPath = process.env.CLAWSEMBLY_EDGE_WASIX;
const imagePath = process.env.CLAWSEMBLY_OPENCLAW_IMAGE;
const providerApiKey = process.env.CLAWSEMBLY_LIVE_PROVIDER_API_KEY;
const brokerPath = process.env.CLAWSEMBLY_PROVIDER_BROKER;
const relayPath = process.env.CLAWSEMBLY_NETWORK_RELAY;
const brokerToken = "clawsembly-one-live-chat-completion";
const relayToken = "clawsembly-brokered-live-network-proof";
const brokerPort = 18_794;
const relayPort = 18_792;
const responseMarker = "CLAWSEMBLY_AGENT_TURN_OK";
const proofTimeoutMs = Number(
  process.env.CLAWSEMBLY_OPENCLAW_LIVE_AGENT_TURN_TIMEOUT_MS ?? "240000"
);

test(
  "unmodified OpenClaw completes a live turn without receiving the provider credential",
  async ({ page }, testInfo) => {
    test.skip(
      process.env.CLAWSEMBLY_OPENCLAW_BROKERED_LIVE_AGENT_TURN_PROOF !== "1"
        || edgeArtifactPath === undefined
        || !existsSync(edgeArtifactPath)
        || imagePath === undefined
        || !existsSync(imagePath)
        || brokerPath === undefined
        || !existsSync(brokerPath)
        || relayPath === undefined
        || !existsSync(relayPath)
        || providerApiKey === undefined
        || providerApiKey.length === 0,
      "Set the brokered proof flag, runtime artifacts, broker, relay, image, and host provider credential"
    );
    test.setTimeout(proofTimeoutMs + 120_000);

    let broker: CapturedProcess | undefined;
    let relay: CapturedProcess | undefined;
    try {
      broker = await startBroker(path.resolve(brokerPath!));
      relay = await startRelay(path.resolve(relayPath!));
      await page.addInitScript((capability) => {
        Object.defineProperty(
          globalThis,
          "__CLAWSEMBLY_LIVE_PROVIDER_CAPABILITY__",
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

async function startBroker(executable: string): Promise<CapturedProcess> {
  const process = captureProcess(spawn(executable, [
    "--listen",
    `127.0.0.1:${brokerPort}`,
    "--model",
    "openai/gpt-4o",
    "--upstream",
    "https://models.github.ai/inference/chat/completions",
    "--max-requests",
    "1"
  ], {
    env: {
      CLAWSEMBLY_PROVIDER_API_KEY: providerApiKey!,
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
      const pageError = page.waitForEvent("pageerror");
      await page.goto(
        "/openclaw-agent-turn-probe.html"
        + "?artifact=/edgejs.wasm"
        + "&image=/openclaw.clawfs"
        + "&proof=brokered-live-agent-turn"
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
        broker.stdout(),
        broker.stderr(),
        relay.stdout(),
        relay.stderr()
      ].join("\n");
      expect(evidenceText).not.toContain(providerApiKey!);
      expect(evidenceText).not.toContain(brokerToken);
      expect(evidenceText).not.toContain(relayToken);
      expect(processText).not.toContain(providerApiKey!);
      expect(processText).not.toContain(brokerToken);
      expect(processText).not.toContain(relayToken);

      const browserEvidence =
        JSON.parse(evidenceText) as BrokeredLiveAgentTurnEvidence;
      expect(browserEvidence).toMatchObject({
        schemaVersion: 1,
        status: "brokered-live-agent-turn-pass",
        agentResponseValidation: {
          arbitraryMetadataSearched: false,
          contract: "strict-assistant-payload-v1",
          promptEchoesAccepted: false
        },
        credentialBroker: {
          api: "openai-completions",
          browserReceivesProviderCredential: false,
          guestEndpoint: "http://localhost:18794/v1",
          guestOperationCapability: {
            authority:
              "POST http://localhost:18794/v1/chat/completions",
            model: "openai/gpt-4o",
            recorded: false,
            streamingRequired: true
          },
          expectedMarker: responseMarker,
          model: "clawsembly-broker/openai/gpt-4o",
          provider: {
            authentication: {
              credential: "job-scoped GITHUB_TOKEN",
              recorded: false,
              repositoryContentsPermission: "none",
              workflowPermissions: ["models: read"]
            },
            endpoint:
              "https://models.github.ai/inference/chat/completions",
            model: "openai/gpt-4o",
            tls: {
              authority: "models.github.ai",
              terminatedBy: "clawsembly-provider-broker",
              validation:
                "Rustls HTTPS with platform certificate validation",
              visibleToGuest: false
            }
          },
          security: {
            exactEndpointAndModel: true,
            loopbackOnly: true,
            maxConcurrency: 1,
            maxRequestBytes: 2_097_152,
            maxRequests: 1,
            maxResponseBytes: 2_097_152,
            redirects: "disabled",
            systemProxy: "disabled"
          }
        },
        network: {
          namespace:
            "browser-local-loopback+credential-broker-capability-egress",
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
        "provider credential remained in the OSS host broker"
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
        "provider credential remains outside the browser"
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
        upstreamAuthority: "models.github.ai:443",
        model: "openai/gpt-4o",
        maxRequests: 1,
        maxConcurrency: 1,
        providerCredentialRecorded: false
      });
      expect(upstreamResponse).toMatchObject({
        status: "upstream-response",
        requestId: 1,
        requestNumber: 1,
        httpStatus: 200,
        model: "openai/gpt-4o",
        stream: true,
        providerCredentialRecorded: false,
        requestBodyRecorded: false
      });

      const evidence: BrokeredLiveAgentTurnEvidence = {
        ...browserEvidence,
        credentialBroker: {
          ...browserEvidence.credentialBroker,
          hostProcess: {
            ready: ready!,
            upstreamResponse: upstreamResponse!
          }
        }
      };
      const serializedEvidence = `${JSON.stringify(evidence, null, 2)}\n`;
      expect(serializedEvidence).not.toContain(providerApiKey!);
      expect(serializedEvidence).not.toContain(brokerToken);
      expect(serializedEvidence).not.toContain(relayToken);
      writeFileSync(
        testInfo.outputPath(
          "openclaw-brokered-live-agent-turn-browser-evidence.json"
        ),
        serializedEvidence
      );
      await testInfo.attach(
        "openclaw-brokered-live-agent-turn-browser-evidence",
        {
          body: Buffer.from(serializedEvidence),
          contentType: "application/json"
        }
      );
    } finally {
      relay?.child.kill("SIGTERM");
      broker?.child.kill("SIGTERM");
    }
  }
);
