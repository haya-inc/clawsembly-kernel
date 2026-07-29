import { expect, test } from "@playwright/test";
import { existsSync, writeFileSync } from "node:fs";

const edgeArtifactPath = process.env.CLAWSEMBLY_EDGE_WASIX;
const imagePath = process.env.CLAWSEMBLY_OPENCLAW_IMAGE;
const responseMarker = "CLAWSEMBLY_AGENT_TURN_OK";
const model = "clawsembly-proof";
const apiKey = "sk-user-owned-full-browser-proof";
const sessionId = "a".repeat(64);
const guestToken = `${sessionId}.guest_capability_for_full_proof_123456`;
const adminToken = `${sessionId}.admin_capability_for_full_proof_123456`;

function streamingResponse(): string {
  const created = 1_785_134_400;
  return [
    `data: ${JSON.stringify({
      id: "chatcmpl-clawsembly-byok",
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{
        index: 0,
        delta: {
          role: "assistant",
          content: responseMarker
        },
        finish_reason: null
      }]
    })}\n\n`,
    `data: ${JSON.stringify({
      id: "chatcmpl-clawsembly-byok",
      object: "chat.completion.chunk",
      created,
      model,
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
    })}\n\n`,
    "data: [DONE]\n\n"
  ].join("");
}

test("unmodified OpenClaw completes a BYOK turn through the host HTTP bridge", async ({
  page
}, testInfo) => {
  test.skip(
    !edgeArtifactPath
      || !imagePath
      || !existsSync(edgeArtifactPath)
      || !existsSync(imagePath),
    "Set CLAWSEMBLY_EDGE_WASIX and CLAWSEMBLY_OPENCLAW_IMAGE"
  );
  test.setTimeout(300_000);
  const providerRequests: unknown[] = [];

  await page.route("**/edgejs.wasm", async (route) => {
    await route.fulfill({
      contentType: "application/wasm",
      path: edgeArtifactPath
    });
  });
  await page.route("**/api/byok/capabilities", async (route) => {
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        status: "ready",
        capability: {
          token: guestToken,
          adminToken,
          provider: "openai",
          providerLabel: "OpenAI",
          model,
          providerId: "clawsembly-byok",
          baseUrl: "http://127.0.0.1:4173/api/byok/v1",
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          maxRequests: 64
        }
      })
    });
  });
  await page.route("**/api/byok/v1/chat/completions", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as {
      stream?: unknown;
    };
    providerRequests.push(body);
    if (body.stream === true) {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: streamingResponse()
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: "READY"
          }
        }]
      })
    });
  });
  await page.route("**/api/byok/capabilities/revoke", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        status: "revoked",
        alreadyRevoked: false
      })
    });
  });

  await page.goto("/onboard.html");
  await page.locator("#byok-model").fill(model);
  await page.locator("#byok-key").fill(apiKey);
  await page.getByRole("button", { name: "安全な接続を作る" }).click();
  await page.getByRole("button", { name: "接続を確認" }).click();
  await expect(page.locator("#byok-test-result"))
    .toContainText("接続確認済み · READY");
  await page.getByRole("button", { name: "OpenClawを起動" }).click();

  const runtime = page.frameLocator("#byok-runtime-frame");
  const status = runtime.locator("#status");
  await expect.poll(
    () => status.getAttribute("data-state"),
    { timeout: 280_000 }
  ).toMatch(/^(?:pass|fail)$/u);
  if (await status.getAttribute("data-state") === "fail") {
    throw new Error(await runtime.locator("#result").innerText());
  }

  const evidenceText = await runtime.locator("#result").innerText();
  const evidence = JSON.parse(evidenceText) as {
    byokModel: {
      guestReceivesProviderCredential: boolean;
      hostBridge: {
        stats: {
          forwarded: number;
          providerCredentialRecorded: boolean;
        };
      };
      model: string;
    };
    network: {
      namespace: string;
    };
    status: string;
  };
  expect(evidence).toMatchObject({
    status: "byok-agent-turn-pass",
    network: {
      namespace: "browser-local-loopback+host-http-capability-bridge"
    },
    byokModel: {
      guestReceivesProviderCredential: false,
      model: `clawsembly-byok/${model}`,
      hostBridge: {
        stats: {
          forwarded: 1,
          providerCredentialRecorded: false
        }
      }
    }
  });
  expect(evidenceText).not.toContain(apiKey);
  expect(evidenceText).not.toContain(guestToken);
  expect(providerRequests).toHaveLength(2);
  expect(providerRequests[1]).toMatchObject({
    model,
    stream: true
  });
  const evidencePath = testInfo.outputPath(
    "byok-openclaw-browser-evidence.json"
  );
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  await testInfo.attach("byok-openclaw-browser-evidence", {
    body: Buffer.from(JSON.stringify(evidence, null, 2)),
    contentType: "application/json"
  });
});
