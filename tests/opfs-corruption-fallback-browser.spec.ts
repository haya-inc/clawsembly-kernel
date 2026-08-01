import { expect, test } from "@playwright/test";

test("rejects a corrupt boot snapshot and creates clean state", async ({
  page
}) => {
  await page.goto("/tests/fixtures/opfs-corruption-fallback.html");
  const status = page.locator("#status");
  await expect.poll(
    () => status.getAttribute("data-state"),
    { timeout: 30_000 }
  ).toMatch(/^(?:pass|fail)$/u);
  if (await status.getAttribute("data-state") === "fail") {
    throw new Error(await page.locator("#result").innerText());
  }
  const evidence = JSON.parse(
    await page.locator("#result").innerText()
  ) as {
    fallbackMarker: string;
    resolution: {
      fallbackError: string;
      mode: string;
      value: string;
    };
  };
  expect(evidence).toMatchObject({
    fallbackMarker: "clean-fallback",
    resolution: {
      fallbackError: "OPFS snapshot manifest hash mismatch",
      mode: "cold",
      value: "fresh"
    }
  });
});
