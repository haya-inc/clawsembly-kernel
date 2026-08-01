import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";

const edgeArtifactPath = process.env.CLAWSEMBLY_EDGE_WASIX;
const imagePath = process.env.CLAWSEMBLY_OPENCLAW_IMAGE;

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
      /^OFFICIAL OPENCLAW WIZARD · (?:ACTION|CONFIRM|MULTISELECT|NOTE|PROGRESS|SELECT|TEXT)$/u
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
