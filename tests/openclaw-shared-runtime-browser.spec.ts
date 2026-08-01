import { expect, test } from "@playwright/test";

const sharedProbeStub = `
const host = globalThis.__clawsemblyOpenClawRuntimeHost;
host.status.dataset.state = "running";
host.status.textContent = "Starting shared stub OpenClaw runtime…";
host.addMessageListener((message) => {
  if (message.type !== "clawsembly:wizard-rpc-request") return;
  host.postMessage({
    type: "clawsembly:wizard-rpc-response",
    requestId: message.requestId,
    ok: true,
    result: { client: message.params.client }
  });
});
setTimeout(() => {
  host.status.dataset.state = "pass";
  host.status.textContent = "READY · Shared stub OpenClaw runtime";
  host.postMessage({
    type: "clawsembly:wizard-gateway-ready",
    bootMode: "warm",
    openclawVersion: "shared-stub"
  });
}, 300);
`;

test("shares one OpenClaw owner and routes RPC responses to each tab", async ({
  context,
  page
}) => {
  await context.addInitScript(() => {
    const messages: unknown[] = [];
    Object.defineProperty(window, "__clawsemblyTestMessages", {
      value: messages
    });
    window.addEventListener("message", (event) => {
      messages.push(event.data);
    });
  });
  let moduleLoads = 0;
  await context.route(
    "**/src/openclaw-gateway-health-probe.ts*",
    async (route) => {
      moduleLoads += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/javascript",
        body: sharedProbeStub
      });
    }
  );

  await page.goto("/byok-runtime.html?proof=onboarding");
  await page.evaluate(() => window.postMessage({
    type: "clawsembly:onboarding-runtime-start"
  }, location.origin));
  await expect(page.locator("#status")).toContainText("shared stub");

  const secondPage = await context.newPage();
  await secondPage.goto("/byok-runtime.html?proof=onboarding");
  await secondPage.evaluate(() => window.postMessage({
    type: "clawsembly:onboarding-runtime-start"
  }, location.origin));

  await expect.poll(
    () => page.locator("#status").getAttribute("data-state")
  ).toMatch(/^(?:pass|fail)$/u);
  if (await page.locator("#status").getAttribute("data-state") === "fail") {
    throw new Error(await page.locator("#result").innerText());
  }
  await expect(secondPage.locator("#status")).toHaveAttribute(
    "data-state",
    "pass"
  );
  expect(moduleLoads).toBe(1);
  const secondReady = await secondPage.evaluate(() => (
    window as typeof window & {
      __clawsemblyTestMessages: Array<{
        bootMode?: string;
        type?: string;
      }>;
    }
  ).__clawsemblyTestMessages.find((message) => (
    message.type === "clawsembly:wizard-gateway-ready"
  )));
  expect(secondReady).toMatchObject({ bootMode: "shared" });

  await page.evaluate(() => window.postMessage({
    type: "clawsembly:wizard-rpc-request",
    requestId: "first_request",
    method: "wizard.start",
    params: { client: "first" }
  }, location.origin));
  await secondPage.evaluate(() => window.postMessage({
    type: "clawsembly:wizard-rpc-request",
    requestId: "second_request",
    method: "wizard.start",
    params: { client: "second" }
  }, location.origin));

  const responses = async (
    candidate: typeof page
  ): Promise<Array<{ requestId?: string; result?: { client?: string } }>> =>
    candidate.evaluate(() => (
      window as typeof window & {
        __clawsemblyTestMessages: Array<{
          requestId?: string;
          result?: { client?: string };
          type?: string;
        }>;
      }
    ).__clawsemblyTestMessages.filter((message) => (
      message.type === "clawsembly:wizard-rpc-response"
      && (
        message.requestId === "first_request"
        || message.requestId === "second_request"
      )
    )));

  await expect.poll(() => responses(page)).toEqual([expect.objectContaining({
    requestId: "first_request",
    result: { client: "first" }
  })]);
  await expect.poll(() => responses(secondPage)).toEqual([
    expect.objectContaining({
      requestId: "second_request",
      result: { client: "first" }
    })
  ]);

  await page.close();
  await expect.poll(() => moduleLoads).toBe(2);
  await expect(secondPage.locator("#status")).toHaveAttribute(
    "data-state",
    "pass"
  );
  await secondPage.evaluate(() => window.postMessage({
    type: "clawsembly:wizard-rpc-request",
    requestId: "failover_request",
    method: "wizard.status",
    params: { client: "failover-owner" }
  }, location.origin));
  await expect.poll(async () => {
    const messages = await secondPage.evaluate(() => (
      window as typeof window & {
        __clawsemblyTestMessages: Array<{
          requestId?: string;
          result?: { client?: string };
          type?: string;
        }>;
      }
    ).__clawsemblyTestMessages);
    return messages.find((message) => (
      message.type === "clawsembly:wizard-rpc-response"
      && message.requestId === "failover_request"
    ));
  }).toEqual(expect.objectContaining({
    result: { client: "failover-owner" }
  }));
});
