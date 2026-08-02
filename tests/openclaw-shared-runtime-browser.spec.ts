import { expect, test } from "@playwright/test";

const sharedProbeStub = `
const host = globalThis.__clawsemblyOpenClawRuntimeHost;
let wizardNextCalls=0;
host.status.dataset.state = "running";
host.status.textContent = "Starting shared stub OpenClaw runtime…";
host.addMessageListener((message) => {
  if (message.type !== "clawsembly:wizard-rpc-request") return;
  if(message.method==="wizard.next"){
    wizardNextCalls+=1;
    host.status.dataset.wizardNextCalls=String(wizardNextCalls);
  }
  const result = message.method === "wizard.start"
    ? { client: message.params.client, sessionId: "shared-session" }
    : { client: message.params.client };
  setTimeout(()=>host.postMessage({
      type: "clawsembly:wizard-rpc-response",
      requestId: message.requestId,
      ok: true,
      result
    }),message.method==="wizard.next"?80:0);
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
    const sharedRuntimeNames: string[] = [];
    Object.defineProperty(window, "__clawsemblyTestMessages", {
      value: messages
    });
    Object.defineProperty(window, "__clawsemblySharedRuntimeNames", {
      value: sharedRuntimeNames
    });
    const NativeSharedWorker = window.SharedWorker;
    Object.defineProperty(window, "SharedWorker", {
      configurable: true,
      value: new Proxy(NativeSharedWorker, {
        construct(target, argumentsList) {
          const options = argumentsList[1] as string | WorkerOptions | undefined;
          sharedRuntimeNames.push(
            typeof options === "string" ? options : options?.name ?? ""
          );
          return Reflect.construct(target, argumentsList);
        }
      })
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
  const sharedRuntimeNames = await page.evaluate(() => (
    window as typeof window & {
      __clawsemblySharedRuntimeNames: string[];
    }
  ).__clawsemblySharedRuntimeNames);
  const secondSharedRuntimeNames = await secondPage.evaluate(() => (
    window as typeof window & {
      __clawsemblySharedRuntimeNames: string[];
    }
  ).__clawsemblySharedRuntimeNames);
  expect(sharedRuntimeNames).toHaveLength(1);
  expect(sharedRuntimeNames[0]).toMatch(
    /^clawsembly-openclaw-runtime-v3:initial:https?:\/\//u
  );
  expect(secondSharedRuntimeNames).toEqual(sharedRuntimeNames);
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
    result: expect.objectContaining({ client: "first" })
  })]);
  await expect.poll(() => responses(secondPage)).toEqual([
    expect.objectContaining({
      requestId: "second_request",
      result: expect.objectContaining({ client: "first" })
    })
  ]);

  const duplicateParams = {
    client: "channel-skip",
    sessionId: "shared-session",
    answer: { stepId: "channels", value: "__skip__" }
  };
  await Promise.all([
    page.evaluate((params) => window.postMessage({
      type: "clawsembly:wizard-rpc-request",
      requestId: "duplicate_first",
      method: "wizard.next",
      params
    }, location.origin), duplicateParams),
    secondPage.evaluate((params) => window.postMessage({
      type: "clawsembly:wizard-rpc-request",
      requestId: "duplicate_second",
      method: "wizard.next",
      params
    }, location.origin), duplicateParams)
  ]);
  for (const [candidate, requestId] of [
    [page, "duplicate_first"],
    [secondPage, "duplicate_second"]
  ] as const) {
    await expect.poll(() => candidate.evaluate((id) => (
      window as typeof window & {
        __clawsemblyTestMessages: Array<{
          requestId?: string;
          result?: { client?: string };
          type?: string;
        }>;
      }
    ).__clawsemblyTestMessages.find((message) => (
      message.type === "clawsembly:wizard-rpc-response"
      && message.requestId === id
    )), requestId)).toEqual(expect.objectContaining({
      result: { client: "channel-skip" }
    }));
  }
  await expect(page.locator("#status")).toHaveAttribute(
    "data-wizard-next-calls",
    "1"
  );

  await secondPage.evaluate(() => window.postMessage({
    type: "clawsembly:wizard-rpc-request",
    requestId: "advance_request",
    method: "wizard.next",
    params: { client: "advanced" }
  }, location.origin));
  await expect.poll(() => secondPage.evaluate(() => (
    window as typeof window & {
      __clawsemblyTestMessages: Array<{
        requestId?: string;
        result?: { client?: string };
        type?: string;
      }>;
    }
  ).__clawsemblyTestMessages.find((message) => (
    message.type === "clawsembly:wizard-rpc-response"
    && message.requestId === "advance_request"
  )))).toEqual(expect.objectContaining({
    result: { client: "advanced" }
  }));

  const thirdPage = await context.newPage();
  await thirdPage.goto("/byok-runtime.html?proof=onboarding");
  await thirdPage.evaluate(() => window.postMessage({
    type: "clawsembly:wizard-rpc-request",
    requestId: "third_start",
    method: "wizard.start",
    params: { client: "third" }
  }, location.origin));
  await expect.poll(() => thirdPage.evaluate(() => (
    window as typeof window & {
      __clawsemblyTestMessages: Array<{
        requestId?: string;
        result?: { client?: string; sessionId?: string };
        type?: string;
      }>;
    }
  ).__clawsemblyTestMessages.find((message) => (
    message.type === "clawsembly:wizard-rpc-response"
    && message.requestId === "third_start"
  )))).toEqual(expect.objectContaining({
    result: {
      client: "advanced",
      sessionId: "shared-session"
    }
  }));

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
