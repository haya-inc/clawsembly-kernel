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
}): Promise<{
  elapsedMs: number;
  mode: "cold" | "warm";
  timings: Record<string, number>;
}> {
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
    const timings = JSON.parse(
      await bootProgress.getAttribute("data-boot-timings") ?? "{}"
    ) as Record<string, number>;
    return {
      elapsedMs: Date.now() - startedAt,
      mode,
      timings
    };
  } finally {
    await context.close();
  }
}

async function waitForOnboardingReady(
  page: import("@playwright/test").Page,
  timeout: number
): Promise<void> {
  const bootProgress = page.locator("#boot-progress");
  await expect.poll(
    () => bootProgress.getAttribute("data-state"),
    { timeout }
  ).toMatch(/^(?:ready|fail)$/u);
  if (await bootProgress.getAttribute("data-state") === "fail") {
    throw new Error(
      await page.frameLocator("#byok-runtime-frame")
        .locator("#result")
        .innerText()
    );
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
        stepType: await page.locator(".wizard-stage").getAttribute(
          "data-step-type"
        ),
        state
      };
    },
    { timeout: 460_000 }
  ).toMatchObject({
    origin: expect.stringMatching(/^OpenClaw 公式Wizard · /u),
    stepType: expect.stringMatching(
      /^(?:action|confirm|multiselect|note|progress|select|text)$/u
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
  const firstStepId = await page.locator(".wizard-stage").getAttribute(
    "data-step-id"
  );
  expect(firstStepId).toBeTruthy();
  await page.waitForTimeout(2_000);
  await page.locator("#wizard-controls button").first().click();
  await expect.poll(async () => {
    if (await page.locator("#wizard-error").isVisible()) {
      throw new Error(await page.locator("#wizard-error").innerText());
    }
    return page.locator(".wizard-stage").getAttribute("data-step-id");
  }, { timeout: 130_000 }).not.toBe(firstStepId);
  await expect(page.getByText(/^安全上の注意を詳しく見る/u)).toBeVisible();
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
    path: testInfo.outputPath("real-openclaw-wizard-next-step.png"),
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
      `OpenClaw boot timing: ${JSON.stringify({ cold, warm })}`
    );
    await testInfo.attach("openclaw-boot-timing.json", {
      body: Buffer.from(JSON.stringify({ cold, warm }, null, 2)),
      contentType: "application/json"
    });
  } finally {
    await rm(profileDirectory, { recursive: true, force: true });
  }
});

test("connects a later tab to the already-running OpenClaw Gateway", async ({
  context,
  page
}) => {
  test.skip(
    !edgeArtifactPath
      || !imagePath
      || !existsSync(edgeArtifactPath)
      || !existsSync(imagePath),
    "Set CLAWSEMBLY_EDGE_WASIX and CLAWSEMBLY_OPENCLAW_IMAGE"
  );
  test.setTimeout(540_000);

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
  await waitForOnboardingReady(page, 460_000);

  const follower = await context.newPage();
  const followerStartedAt = Date.now();
  await follower.goto("/onboard.html");
  await waitForOnboardingReady(follower, 15_000);
  const followerElapsedMs = Date.now() - followerStartedAt;

  await expect(follower.locator("#boot-progress")).toHaveAttribute(
    "data-boot-mode",
    "shared"
  );
  await expect(follower.locator("#boot-title")).toHaveText(
    "実行中のOpenClawに接続しました"
  );
  await expect(follower.locator("#wizard-controls button").first())
    .toBeVisible();
  const followerStepId = await follower.locator(".wizard-stage").getAttribute(
    "data-step-id"
  );
  expect(followerStepId).toBeTruthy();
  await follower.locator("#wizard-controls button").first().click();
  await expect.poll(async () => {
    if (await follower.locator("#wizard-error").isVisible()) {
      throw new Error(await follower.locator("#wizard-error").innerText());
    }
    return follower.locator(".wizard-stage").getAttribute("data-step-id");
  }, { timeout: 150_000 }).not.toBe(followerStepId);

  const lateFollower = await context.newPage();
  await lateFollower.goto("/onboard.html");
  await waitForOnboardingReady(lateFollower, 15_000);
  await expect(lateFollower.locator("#boot-progress")).toHaveAttribute(
    "data-boot-mode",
    "shared"
  );
  await expect(lateFollower.locator("#wizard-controls button").first())
    .toBeVisible();
  const lateFollowerStepId = await lateFollower.locator(".wizard-stage")
    .getAttribute("data-step-id");
  expect(lateFollowerStepId).toBeTruthy();
  await lateFollower.locator("#wizard-controls button").first().click();
  await expect.poll(async () => {
    if (await lateFollower.locator("#wizard-error").isVisible()) {
      throw new Error(await lateFollower.locator("#wizard-error").innerText());
    }
    return lateFollower.locator(".wizard-stage").getAttribute("data-step-id");
  }, { timeout: 150_000 }).not.toBe(lateFollowerStepId);
  console.log(`Shared OpenClaw follower timing: ${followerElapsedMs}ms`);
});
