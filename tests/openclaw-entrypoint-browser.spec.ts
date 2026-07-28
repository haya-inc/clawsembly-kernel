import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

type OpenClawArtifactContract = {
  integrity: string;
  name: string;
  nodeEngine: string;
  version: string;
};

type EntrypointEvidence = {
  actualNodeVersion?: string;
  artifactBytes: number;
  blocker?: string;
  crossOriginIsolated: boolean;
  executor: string;
  exitCode: number;
  launcherNodeRange?: string;
  launcherBytes: number;
  requiredNodeEngine?: string;
  schemaVersion: number;
  status: string;
  stderr: string;
  stdout: string;
  version: string;
};

const edgeArtifactPath = process.env.CLAWSEMBLY_EDGE_WASIX;
const openclawArchivePath = process.env.CLAWSEMBLY_OPENCLAW_ARCHIVE;
const contract = JSON.parse(
  readFileSync(
    path.join(process.cwd(), "contracts/openclaw-artifact.json"),
    "utf8"
  )
) as OpenClawArtifactContract;

test("official OpenClaw launcher accepts the source-built compatibility profile", async ({ page }, testInfo) => {
  test.skip(
    edgeArtifactPath === undefined
      || !existsSync(edgeArtifactPath)
      || openclawArchivePath === undefined
      || !existsSync(openclawArchivePath),
    "Set CLAWSEMBLY_EDGE_WASIX and CLAWSEMBLY_OPENCLAW_ARCHIVE"
  );
  test.setTimeout(300_000);

  const resolvedEdgePath = path.resolve(edgeArtifactPath!);
  const resolvedArchivePath = path.resolve(openclawArchivePath!);
  const archiveBytes = readFileSync(resolvedArchivePath);
  const archiveIntegrity = `sha512-${
    createHash("sha512").update(archiveBytes).digest("base64")
  }`;
  expect(archiveIntegrity).toBe(contract.integrity);

  const launcherBytes = execFileSync(
    "tar",
    ["-xOf", resolvedArchivePath, "package/openclaw.mjs"],
    { maxBuffer: 4 * 1024 * 1024 }
  );
  const packageBytes = execFileSync(
    "tar",
    ["-xOf", resolvedArchivePath, "package/package.json"],
    { maxBuffer: 4 * 1024 * 1024 }
  );

  await page.route((url) => url.pathname === "/edgejs.wasm", async (route) => {
    await route.fulfill({
      contentType: "application/wasm",
      path: resolvedEdgePath
    });
  });
  await page.route(
    (url) => url.pathname === "/openclaw/openclaw.mjs",
    async (route) => {
      await route.fulfill({
        body: launcherBytes,
        contentType: "text/javascript"
      });
    }
  );
  await page.route(
    (url) => url.pathname === "/openclaw/package.json",
    async (route) => {
      await route.fulfill({
        body: packageBytes,
        contentType: "application/json"
      });
    }
  );
  page.on("console", (message) => {
    console.log(`[browser:${message.type()}] ${message.text()}`);
  });

  const pageError = page.waitForEvent("pageerror");
  await page.goto(
    "/openclaw-probe.html"
    + "?artifact=/edgejs.wasm"
    + "&launcher=/openclaw/openclaw.mjs"
    + "&package=/openclaw/package.json"
    + "&debug=1"
  );
  const status = page.locator("#status");
  const outcome = await Promise.race([
    expect.poll(
      () => status.getAttribute("data-state"),
      { timeout: 240_000 }
    ).toMatch(/^(?:pass|fail)$/u).then(() => ({ kind: "status" as const })),
    pageError.then((error) => ({ error, kind: "pageerror" as const }))
  ]);
  if (outcome.kind === "pageerror") throw outcome.error;
  const state = await status.getAttribute("data-state");
  if (state === "fail") {
    throw new Error(await page.locator("#result").innerText());
  }

  const evidence = JSON.parse(
    await page.locator("#result").innerText()
  ) as EntrypointEvidence;
  expect(evidence).toMatchObject({
    schemaVersion: 1,
    status: "pass",
    crossOriginIsolated: true,
    executor: "@wasmer/sdk",
    exitCode: 0,
    version: contract.version,
    stdout: `OpenClaw ${contract.version}\n`,
    stderr: ""
  });
  expect(evidence.stderr).not.toContain("missing dist/entry");
  expect(evidence.artifactBytes).toBeGreaterThan(1_000_000);
  expect(evidence.launcherBytes).toBe(launcherBytes.byteLength);

  const persistedEvidence = {
    ...evidence,
    edgeArtifactSha256: createHash("sha256")
      .update(readFileSync(resolvedEdgePath))
      .digest("hex"),
    openclawIntegrity: archiveIntegrity
  };
  const evidencePath = testInfo.outputPath(
    "openclaw-entrypoint-browser-evidence.json"
  );
  writeFileSync(evidencePath, `${JSON.stringify(persistedEvidence, null, 2)}\n`);
  await testInfo.attach("openclaw-entrypoint-browser-evidence", {
    body: Buffer.from(JSON.stringify(persistedEvidence, null, 2)),
    contentType: "application/json"
  });
});
