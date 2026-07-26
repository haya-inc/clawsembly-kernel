import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

type BrowserBuildContract = {
  browserExecutor: {
    package: string;
    version: string;
  };
  expectedRuntime: {
    edge: string;
    marker: string;
    node: string;
    v8: string;
  };
};

type BrowserEvidence = {
  artifactBytes: number;
  crossOriginIsolated: boolean;
  executor: string;
  exitCode: number;
  runtime: {
    edge: string;
    marker: string;
    node: string;
    v8: string;
  };
  schemaVersion: number;
  status: string;
  stderr: string;
};

const artifactPath = process.env.CLAWSEMBLY_EDGE_WASIX;
const contract = JSON.parse(
  readFileSync(
    path.join(process.cwd(), "contracts/edgejs-browser-build.json"),
    "utf8"
  )
) as BrowserBuildContract;

test("self-built Edge.js WASIX starts inside Chromium", async ({ page }, testInfo) => {
  test.skip(
    artifactPath === undefined || !existsSync(artifactPath),
    "Set CLAWSEMBLY_EDGE_WASIX to a self-built Edge.js WASIX module"
  );
  test.setTimeout(300_000);
  const resolvedArtifactPath = path.resolve(artifactPath!);
  await page.route((url) => url.pathname === "/edgejs.wasm", async (route) => {
    await route.fulfill({
      contentType: "application/wasm",
      path: resolvedArtifactPath
    });
  });
  await page.goto("/wasix-probe.html?artifact=/edgejs.wasm");
  const status = page.locator("#status");
  await expect.poll(
    () => status.getAttribute("data-state"),
    { timeout: 240_000 }
  ).toMatch(/^(?:pass|fail)$/u);
  const state = await status.getAttribute("data-state");
  if (state === "fail") {
    throw new Error(await page.locator("#result").innerText());
  }
  expect(state).toBe("pass");
  const evidence = JSON.parse(
    await page.locator("#result").innerText()
  ) as BrowserEvidence;
  expect(evidence).toMatchObject({
    schemaVersion: 1,
    status: "pass",
    crossOriginIsolated: true,
    executor: contract.browserExecutor.package,
    exitCode: 0,
    runtime: contract.expectedRuntime
  });
  expect(evidence.artifactBytes).toBeGreaterThan(1_000_000);

  const artifactSha256 = createHash("sha256")
    .update(readFileSync(resolvedArtifactPath))
    .digest("hex");
  const persistedEvidence = {
    ...evidence,
    artifactSha256
  };
  const evidencePath = testInfo.outputPath(
    "edgejs-wasix-browser-evidence.json"
  );
  writeFileSync(evidencePath, `${JSON.stringify(persistedEvidence, null, 2)}\n`);
  await testInfo.attach("edgejs-wasix-browser-evidence", {
    body: Buffer.from(JSON.stringify(persistedEvidence, null, 2)),
    contentType: "application/json"
  });
});
