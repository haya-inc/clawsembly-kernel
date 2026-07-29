import { expect, test } from "@playwright/test";

test("keeps BYOK secrets out of browser storage and advances the setup", async ({
  page
}, testInfo) => {
  const apiKey = "sk-user-owned-browser-test-key";
  const sessionId = "a".repeat(64);
  const guestToken = `${sessionId}.guest_capability_for_browser_test_123456`;
  const adminToken = `${sessionId}.admin_capability_for_browser_test_123456`;
  const requests: Array<{ apiKey?: string; authorization?: string }> = [];

  await page.route("**/api/byok/capabilities", async (route) => {
    const request = route.request();
    requests.push(JSON.parse(request.postData() ?? "{}") as {
      apiKey?: string;
    });
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
          model: "gpt-5.6",
          providerId: "clawsembly-byok",
          baseUrl: "http://127.0.0.1:4173/api/byok/v1",
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          maxRequests: 64
        }
      })
    });
  });
  await page.route("**/api/byok/v1/chat/completions", async (route) => {
    requests.push({
      authorization: route.request().headers().authorization
    });
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
    requests.push({
      authorization: route.request().headers().authorization
    });
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
  await expect(page.getByRole("heading", {
    name: "自分のキーで OpenClawを動かす。"
  })).toBeVisible();
  const keyInput = page.locator("#byok-key");
  await expect(keyInput).toHaveAttribute("type", "password");
  await expect(keyInput).toHaveAttribute("autocomplete", "off");
  await keyInput.fill(apiKey);
  await page.getByRole("button", { name: "安全な接続を作る" }).click();

  await expect(page.locator("#byok-status")).toContainText("OpenAI 接続済み");
  await expect(keyInput).toHaveValue("");
  await expect(page.locator(".byok-session")).toBeVisible();
  await expect(page.getByRole("button", { name: "OpenClawを起動" }))
    .toBeDisabled();
  await expect(page.locator("body")).not.toContainText(apiKey);
  expect(requests[0]).toEqual({ apiKey, provider: "openai", model: "gpt-5.6" });

  const browserStorage = await page.evaluate(() => ({
    local: { ...localStorage },
    session: { ...sessionStorage }
  }));
  expect(browserStorage).toEqual({ local: {}, session: {} });

  await page.getByRole("button", { name: "接続を確認" }).click();
  await expect(page.locator("#byok-test-result"))
    .toContainText("接続確認済み · READY");
  await expect(page.locator("#byok-status"))
    .toContainText("OpenClawへ接続可能");
  await expect(page.getByRole("button", { name: "OpenClawを起動" }))
    .toBeEnabled();
  expect(requests[1]).toEqual({
    authorization: `Bearer ${guestToken}`
  });

  await page.screenshot({
    path: testInfo.outputPath("byok-onboarding.png"),
    fullPage: true
  });

  await page.getByRole("button", { name: "接続を破棄" }).click();
  await expect(page.locator("#byok-status")).toContainText("破棄済み");
  await expect(page.locator(".byok-session")).toBeHidden();
  expect(requests[2]).toEqual({
    authorization: `Bearer ${adminToken}`
  });
});
