import { chromium, expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const edgeArtifactPath = process.env.CLAWSEMBLY_EDGE_WASIX;
const imagePath = process.env.CLAWSEMBLY_OPENCLAW_IMAGE;

async function runPersistentOnboardingBoot(options: {
  artifactPath: string;
  baseURL: string;
  profileDirectory: string;
}): Promise<{ elapsedMs: number; mode: "cold" | "warm" }> {
  const context = await chromium.launchPersistentContext(
    options.profileDirectory,
    { headless: true }
  );
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.route("**/edgejs.wasm", async (route) => {
      await route.fulfill({
        contentType: "application/wasm",
        headers: {
          "Cross-Origin-Resource-Policy": "same-origin"
        },
        path: options.artifactPath
      });
    });
    const startedAt = Date.now();
    const pageError = page.waitForEvent("pageerror").then(async (error) => ({
      error,
      kind: "pageerror" as const,
      runtimeResult: await page.frameLocator("#byok-runtime-frame")
        .locator("#result")
        .innerText()
        .catch(() => ""),
      runtimeStatus: await page.frameLocator("#byok-runtime-frame")
        .locator("#status")
        .innerText()
        .catch(() => "")
    }));
    await page.goto(`${options.baseURL}/onboard.html`);
    const bootProgress = page.locator("#boot-progress");
    const outcome = await Promise.race([
      expect.poll(
        () => bootProgress.getAttribute("data-state"),
        { timeout: 460_000 }
      ).toMatch(/^(?:ready|fail)$/u).then(() => ({
        kind: "terminal" as const
      })),
      pageError
    ]);
    if (outcome.kind === "pageerror") {
      throw new Error(
        `OpenClaw page error: ${outcome.error.message}\n`
        + `runtime status: ${outcome.runtimeStatus}\n`
        + `runtime result: ${outcome.runtimeResult}`
      );
    }
    if (await bootProgress.getAttribute("data-state") === "fail") {
      throw new Error(
        await page.frameLocator("#byok-runtime-frame")
          .locator("#result")
          .innerText()
      );
    }
    const mode = await bootProgress.getAttribute("data-boot-mode");
    if (mode !== "cold" && mode !== "warm") {
      throw new Error(`Unexpected OpenClaw boot mode: ${String(mode)}`);
    }
    return {
      elapsedMs: Date.now() - startedAt,
      mode
    };
  } finally {
    await context.close();
  }
}

async function runtimeRequest(
  page: import("@playwright/test").Page,
  type: string,
  payload: Record<string, unknown>,
  responseType: string
): Promise<unknown> {
  return page.evaluate(({
    payload: requestPayload,
    responseType: expectedResponseType,
    type: requestType
  }) => {
    return new Promise((resolve, reject) => {
      const frame = document.querySelector<HTMLIFrameElement>(
        "#byok-runtime-frame"
      );
      if (!frame?.contentWindow) {
        reject(new Error("runtime frame unavailable"));
        return;
      }
      const requestId = crypto.randomUUID();
      const timeout = window.setTimeout(() => {
        window.removeEventListener("message", onMessage);
        reject(new Error(`Runtime request timed out: ${requestType}`));
      }, 130_000);
      const onMessage = (event: MessageEvent) => {
        const message = event.data as {
          error?: unknown;
          ok?: unknown;
          requestId?: unknown;
          result?: unknown;
          type?: unknown;
        };
        if (
          event.origin !== location.origin
          || event.source !== frame.contentWindow
          || message.type !== expectedResponseType
          || message.requestId !== requestId
        ) {
          return;
        }
        window.clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        if (message.ok === true) resolve(JSON.stringify(message.result));
        else reject(new Error(String(message.error ?? "RPC failed")));
      };
      window.addEventListener("message", onMessage);
      frame.contentWindow.postMessage({
        type: requestType,
        requestId,
        ...requestPayload
      }, location.origin);
    });
  }, { type, payload, responseType }).then((value) =>
    JSON.parse(String(value)) as unknown);
}

test("renders the first real step from the unmodified OpenClaw Wizard", async ({
  page
}, testInfo) => {
  test.skip(
    !edgeArtifactPath
      || !imagePath
      || !existsSync(edgeArtifactPath)
      || !existsSync(imagePath),
    "Set CLAWSEMBLY_EDGE_WASIX and CLAWSEMBLY_OPENCLAW_IMAGE"
  );
  test.setTimeout(480_000);

  await page.route("**/edgejs.wasm", async (route) => {
    await route.fulfill({
      contentType: "application/wasm",
      headers: {
        "Cross-Origin-Resource-Policy": "same-origin"
      },
      path: edgeArtifactPath
    });
  });
  await page.goto("/onboard.html");

  const wizardOrigin = page.locator("#wizard-origin");
  await expect.poll(
    async () => {
      const state = await page.locator("#byok-status").getAttribute(
        "data-state"
      );
      if (state === "fail") {
        throw new Error(
          await page.frameLocator("#byok-runtime-frame")
            .locator("#result")
            .innerText()
        );
      }
      return {
        origin: await wizardOrigin.innerText(),
        state
      };
    },
    { timeout: 460_000 }
  ).toMatchObject({
    origin: expect.stringMatching(
      /^OpenClaw 公式Wizard · (?:action|confirm|multiselect|note|progress|select|text)$/u
    )
  });

  const runtime = page.frameLocator("#byok-runtime-frame");
  const runtimeState = await runtime.locator("#status").getAttribute(
    "data-state"
  );
  if (runtimeState === "fail") {
    throw new Error(await runtime.locator("#result").innerText());
  }
  await expect(page.locator("#wizard-controls button").first()).toBeVisible();
  await expect(page.locator("#wizard-title")).not.toHaveText(
    "公式Wizardを準備しています"
  );
  await runtimeRequest(
    page,
    "clawsembly:wizard-capability-attach",
    {
      capability: {
        apiKey: "opaque-test-capability",
        apiPath: "/v1/responses",
        baseUrl: "http://127.0.0.1:4173/api/byok/v1",
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        model: "gpt-5.6-sol",
        modelApi: "openai-chatgpt-responses",
        openClawProvider: "openai",
        providerId: "clawsembly-byok"
      }
    },
    "clawsembly:wizard-capability-response"
  );
  const configured = await runtimeRequest(
    page,
    "clawsembly:wizard-capability-configure",
    {},
    "clawsembly:wizard-capability-config-response"
  ) as {
    primaryModel?: string;
    providerId?: string;
  };
  expect(configured).toEqual(expect.objectContaining({
    primaryModel: "openai/gpt-5.6-sol",
    providerId: "openai"
  }));
  await page.screenshot({
    path: testInfo.outputPath("real-openclaw-wizard-first-step.png"),
    fullPage: true
  });
});

test("restores the verified OpenClaw boot state after a browser restart", async ({
  baseURL
}, testInfo) => {
  test.skip(
    !edgeArtifactPath
      || !imagePath
      || !existsSync(edgeArtifactPath)
      || !existsSync(imagePath),
    "Set CLAWSEMBLY_EDGE_WASIX and CLAWSEMBLY_OPENCLAW_IMAGE"
  );
  test.setTimeout(960_000);
  if (!baseURL) throw new Error("Playwright baseURL is required");

  const profileDirectory = await mkdtemp(
    path.join(tmpdir(), "clawsembly-warm-boot-profile-")
  );
  try {
    const cold = await runPersistentOnboardingBoot({
      artifactPath: edgeArtifactPath!,
      baseURL,
      profileDirectory
    });
    const warm = await runPersistentOnboardingBoot({
      artifactPath: edgeArtifactPath!,
      baseURL,
      profileDirectory
    });

    expect(cold.mode).toBe("cold");
    expect(warm.mode).toBe("warm");
    console.log(
      `OpenClaw boot timing: cold=${cold.elapsedMs}ms warm=${warm.elapsedMs}ms`
    );
    await testInfo.attach("openclaw-boot-timing.json", {
      body: Buffer.from(JSON.stringify({ cold, warm }, null, 2)),
      contentType: "application/json"
    });
  } finally {
    await rm(profileDirectory, { recursive: true, force: true });
  }
});
