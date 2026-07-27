import { expect, test } from "@playwright/test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

type LiveAgentTurnEvidence = {
  claim: string;
  client: {
    args: string[];
    distinctGuestProcess: boolean;
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
  liveProvider: {
    api: string;
    authentication: {
      credential: string;
      providerEgress: string;
      recorded: boolean;
      workflowPermissions: string[];
    };
    baseUrl: string;
    expectedMarker: string;
    model: string;
    tls: {
      authority: string;
      terminatedByRelay: boolean;
      validation: string;
    };
  };
  network: {
    externalEgress: {
      allow: Array<{
        allowPrivateNetwork: boolean;
        host: string;
        port: number;
      }>;
      credentialTransport: string;
      guestTls: {
        authority: string;
        certificateValidation: string;
      };
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

const edgeArtifactPath = process.env.CLAWSEMBLY_EDGE_WASIX;
const imagePath = process.env.CLAWSEMBLY_OPENCLAW_IMAGE;
const providerApiKey = process.env.CLAWSEMBLY_LIVE_PROVIDER_API_KEY;
const relayPath = process.env.CLAWSEMBLY_NETWORK_RELAY;
const relayToken = "clawsembly-live-agent-turn-proof";
const relayPort = 18_792;
const responseMarker = "CLAWSEMBLY_AGENT_TURN_OK";
const proofTimeoutMs = Number(
  process.env.CLAWSEMBLY_OPENCLAW_LIVE_AGENT_TURN_TIMEOUT_MS ?? "240000"
);

test("unmodified OpenClaw completes a live model turn over guest TLS", async ({
  page
}, testInfo) => {
  test.skip(
    process.env.CLAWSEMBLY_OPENCLAW_LIVE_AGENT_TURN_PROOF !== "1"
      || edgeArtifactPath === undefined
      || !existsSync(edgeArtifactPath)
      || imagePath === undefined
      || !existsSync(imagePath)
      || relayPath === undefined
      || !existsSync(relayPath)
      || providerApiKey === undefined
      || providerApiKey.length === 0,
    "Set the live proof flag, runtime artifacts, package image, relay, and API capability"
  );
  test.setTimeout(proofTimeoutMs + 120_000);

  let relay: ChildProcessWithoutNullStreams | undefined;
  try {
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
      providerApiKey: providerApiKey!,
      relayToken
    });
    await page.route((url) => url.pathname === "/edgejs.wasm", async (route) => {
      await route.fulfill({
        contentType: "application/wasm",
        path: path.resolve(edgeArtifactPath!)
      });
    });

    const pageError = page.waitForEvent("pageerror");
    await page.goto(
      "/openclaw-agent-turn-probe.html"
      + "?artifact=/edgejs.wasm"
      + "&image=/openclaw.clawfs"
      + "&proof=live-agent-turn"
      + "&relay=ws%3A%2F%2F127.0.0.1%3A18792%2Fv1%2Fnetwork"
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
    if (await status.getAttribute("data-state") === "fail") {
      throw new Error(await page.locator("#result").innerText());
    }

    const evidenceText = await page.locator("#result").innerText();
    expect(evidenceText).not.toContain(providerApiKey!);
    expect(evidenceText).not.toContain(relayToken);
    const evidence = JSON.parse(evidenceText) as LiveAgentTurnEvidence;
    expect(evidence).toMatchObject({
      schemaVersion: 1,
      status: "live-agent-turn-pass",
      liveProvider: {
        api: "openai-completions",
        authentication: {
          credential: "job-scoped GITHUB_TOKEN",
          providerEgress:
            "models.github.ai:443 DNS-derived TCP grant",
          recorded: false,
          workflowPermissions: ["contents: read", "models: read"]
        },
        baseUrl: "https://models.github.ai/inference",
        expectedMarker: responseMarker,
        model: "github-models/openai/gpt-4o",
        tls: {
          authority: "models.github.ai",
          terminatedByRelay: false,
          validation: "guest Node TLS/SNI certificate validation"
        }
      },
      network: {
        namespace: "browser-local-loopback+live-tls-capability-egress",
        url: "ws://127.0.0.1:18789",
        externalEgress: {
          transport: "self-hosted-virtual-net-websocket-relay",
          credentialTransport: "Sec-WebSocket-Protocol",
          tokenRecorded: false,
          guestTls: {
            authority: "models.github.ai",
            certificateValidation:
              "Node TLS/SNI validates the provider certificate"
          },
          allow: [{
            host: "models.github.ai",
            port: 443,
            allowPrivateNetwork: false
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
          "60",
          "--json"
        ],
        distinctGuestProcess: true
      },
      launchHarness: {
        openclawPackageFilesMutated: false
      }
    });
    expect(evidence.claim).toContain("live GitHub Models reply");
    expect(evidence.client.result.stdout).toContain(responseMarker);
    expect(evidence.gateway.stdout).toContain("[ws] ← req agent");
    expect(evidence.gateway.stdout).toContain("[ws] → res ✓ agent");
    expect([
      "running-at-agent-turn-proof",
      "exited-after-agent-turn-output"
    ]).toContain(evidence.gateway.state);
    expect(evidence.notNorthStarCompletion).toContain(
      "live authorized model turn"
    );
    expect(evidence.notNorthStarCompletion).toContain(
      "OPFS recovery is proven separately"
    );

    writeFileSync(
      testInfo.outputPath("openclaw-live-agent-turn-browser-evidence.json"),
      `${JSON.stringify(evidence, null, 2)}\n`
    );
    await testInfo.attach("openclaw-live-agent-turn-browser-evidence", {
      body: Buffer.from(JSON.stringify(evidence, null, 2)),
      contentType: "application/json"
    });
  } finally {
    relay?.kill("SIGTERM");
  }
});

async function startRelay(
  executable: string
): Promise<ChildProcessWithoutNullStreams> {
  const relay = spawn(executable, [
    "--listen",
    `127.0.0.1:${relayPort}`,
    "--allow",
    "models.github.ai:443"
  ], {
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => key !== "CLAWSEMBLY_LIVE_PROVIDER_API_KEY"
        )
      ),
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
  });
  relay.stderr.on("data", (chunk: string) => {
    stderr += chunk;
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
