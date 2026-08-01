import { expect, test } from "@playwright/test";

const probeStub = `
const status = document.querySelector("#status");
status.dataset.state = "running";
status.textContent = "Starting stub OpenClaw runtime…";
setTimeout(() => {
  status.dataset.state = "pass";
  status.textContent = "READY · Stub OpenClaw runtime";
}, 500);
`;

test("serializes expensive OpenClaw bootstrap across same-origin tabs", async ({
  context,
  page
}) => {
  let moduleLoads = 0;
  await context.route(
    "**/src/openclaw-gateway-health-probe.ts*",
    async (route) => {
      moduleLoads += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/javascript",
        body: probeStub
      });
    }
  );

  const secondPage = await context.newPage();
  await Promise.all([
    page.goto("/byok-runtime.html"),
    secondPage.goto("/byok-runtime.html")
  ]);

  await page.evaluate(() => window.postMessage({
    type: "clawsembly:onboarding-runtime-start"
  }, location.origin));
  await expect(page.locator("#status")).toContainText("Starting stub");

  await secondPage.evaluate(() => window.postMessage({
    type: "clawsembly:onboarding-runtime-start"
  }, location.origin));
  await expect(secondPage.locator("#status")).toContainText(
    "Waiting for another Clawsembly tab"
  );
  expect(moduleLoads).toBe(1);

  await expect(page.locator("#status")).toHaveAttribute(
    "data-state",
    "pass"
  );
  await expect(secondPage.locator("#status")).toContainText(
    "Starting stub"
  );
  await expect(secondPage.locator("#status")).toHaveAttribute(
    "data-state",
    "pass"
  );
  expect(moduleLoads).toBe(2);
});
