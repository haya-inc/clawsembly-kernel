import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  existsSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

type PackageImageEvidence = {
  assembly: {
    lifecycleScripts: {
      entries: unknown[];
      executed: boolean;
    };
  };
  image: {
    bytes: number;
    files: number;
    payloadBytes: number;
    sha256: string;
    version: number;
  };
  packageContract: {
    artifactFiles: {
      entry: {
        bytes: number;
        path: string;
        sha256: string;
      };
      launcher: {
        bytes: number;
        path: string;
        sha256: string;
      };
    };
    dependencyArchives: number;
    packageJsonSha256: string;
    shrinkwrapSha256: string;
  };
};

type BrowserEvidence = {
  crossOriginIsolated: boolean;
  dependencySample: {
    name: string;
    version: string;
  };
  executor: string;
  image: {
    bytes: number;
    files: number;
    payloadBytes: number;
    version: number;
  };
  openclaw: {
    entryBytes: number;
    entrySha256: string;
    launcherBytes: number;
    launcherSha256: string;
    name: string;
    packageJsonSha256: string;
    shrinkwrapSha256: string;
    version: string;
  };
  schemaVersion: number;
  status: string;
};

const imagePath = process.env.CLAWSEMBLY_OPENCLAW_IMAGE;
const imageEvidencePath =
  process.env.CLAWSEMBLY_OPENCLAW_IMAGE_EVIDENCE;

async function sha256File(filename: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

test("complete integrity-pinned OpenClaw package graph mounts in Chromium", async ({
  page
}, testInfo) => {
  test.skip(
    imagePath === undefined
      || !existsSync(imagePath)
      || imageEvidencePath === undefined
      || !existsSync(imageEvidencePath),
    "Set CLAWSEMBLY_OPENCLAW_IMAGE and CLAWSEMBLY_OPENCLAW_IMAGE_EVIDENCE"
  );
  test.setTimeout(300_000);

  const resolvedImagePath = path.resolve(imagePath!);
  const buildEvidence = JSON.parse(
    readFileSync(path.resolve(imageEvidencePath!), "utf8")
  ) as PackageImageEvidence;
  expect(await sha256File(resolvedImagePath)).toBe(
    buildEvidence.image.sha256
  );
  expect(buildEvidence.packageContract.dependencyArchives).toBe(308);
  expect(buildEvidence.assembly.lifecycleScripts.executed).toBe(false);
  expect(buildEvidence.assembly.lifecycleScripts.entries).toHaveLength(4);

  const pageError = page.waitForEvent("pageerror");
  await page.goto(
    "/package-image-probe.html?image=/openclaw.clawfs"
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
  if (await status.getAttribute("data-state") === "fail") {
    throw new Error(await page.locator("#result").innerText());
  }

  const evidence = JSON.parse(
    await page.locator("#result").innerText()
  ) as BrowserEvidence;
  expect(evidence).toMatchObject({
    schemaVersion: 1,
    status: "pass",
    crossOriginIsolated: true,
    executor: "@wasmer/sdk Directory",
    image: {
      bytes: buildEvidence.image.bytes,
      files: buildEvidence.image.files,
      payloadBytes: buildEvidence.image.payloadBytes,
      version: buildEvidence.image.version
    },
    openclaw: {
      name: "openclaw",
      version: "2026.7.1-2",
      packageJsonSha256: buildEvidence.packageContract.packageJsonSha256,
      shrinkwrapSha256: buildEvidence.packageContract.shrinkwrapSha256,
      launcherBytes:
        buildEvidence.packageContract.artifactFiles.launcher.bytes,
      launcherSha256:
        buildEvidence.packageContract.artifactFiles.launcher.sha256,
      entryBytes: buildEvidence.packageContract.artifactFiles.entry.bytes,
      entrySha256: buildEvidence.packageContract.artifactFiles.entry.sha256
    },
    dependencySample: {
      name: "chalk",
      version: "5.6.2"
    }
  });
  const persistedEvidence = {
    ...evidence,
    imageSha256: buildEvidence.image.sha256,
    dependencyArchives: buildEvidence.packageContract.dependencyArchives,
    lifecycleScriptsExecuted:
      buildEvidence.assembly.lifecycleScripts.executed
  };
  writeFileSync(
    testInfo.outputPath("openclaw-package-image-browser-evidence.json"),
    `${JSON.stringify(persistedEvidence, null, 2)}\n`
  );
  await testInfo.attach("openclaw-package-image-browser-evidence", {
    body: Buffer.from(JSON.stringify(persistedEvidence, null, 2)),
    contentType: "application/json"
  });
});
