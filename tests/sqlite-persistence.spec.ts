import { expect, test } from "@playwright/test";

test("DatabaseSync-compatible SQLite persists across fresh workers", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "pass", {
    timeout: 30_000
  });
  await expect(page.locator("#status")).toHaveText(
    "PASS · persisted across two workers"
  );

  const evidence = JSON.parse(await page.locator("#result").textContent() ?? "{}");
  expect(evidence).toMatchObject({
    status: "pass",
    crossOriginIsolated: true,
    workerGenerations: 2,
    read: {
      columns: ["id", "value"],
      readOnly: true,
      rows: [
        { id: 1, value: "written-by-worker-one" },
        { id: 2, value: "persisted-in-opfs" }
      ]
    }
  });
  expect(evidence.read.sqliteVersion).toMatch(/^3\.53\./);
});
