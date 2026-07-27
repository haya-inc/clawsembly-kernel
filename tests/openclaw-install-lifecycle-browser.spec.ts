import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

type BuildEvidence = {
  image: {
    bytes: number;
    files: number;
    payloadBytes: number;
    sha256: string;
    version: number;
  };
  packageContract: {
    packageJsonSha256: string;
  };
};

type LifecycleEvidence = {
  crossOriginIsolated: boolean;
  image: {
    bytes: number;
    files: number;
    payloadBytes: number;
    sha256: string;
    version: number;
  };
  lifecycle: {
    executor: string;
    packageFiles: {
      mutated: boolean;
    };
    requiredEffects: {
      executions: Array<{
        command: string;
        package: string;
        result: {
          code: number;
          ok: boolean;
        };
      }>;
      packageStateDatabase: {
        bytes: number;
        hostContractVersion: string;
        indexedPlugins: number;
        migrationVersion: number;
        path: string;
        refreshReason: string;
      };
    };
    reviewedNonEffects: Array<{
      disposition: string;
      package: string;
    }>;
    status: string;
  };
  openclaw: {
    name: string;
    packageJsonSha256: string;
    version: string;
  };
  schemaVersion: number;
  status: string;
};

const edgeArtifactPath = process.env.CLAWSEMBLY_EDGE_WASIX;
const imagePath = process.env.CLAWSEMBLY_OPENCLAW_IMAGE;
const imageEvidencePath =
  process.env.CLAWSEMBLY_OPENCLAW_IMAGE_EVIDENCE;

async function sha256File(filename: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

test("required OpenClaw install effects execute in the browser kernel", async ({
  page
}, testInfo) => {
  test.skip(
    edgeArtifactPath === undefined
      || !existsSync(edgeArtifactPath)
      || imagePath === undefined
      || !existsSync(imagePath)
      || imageEvidencePath === undefined
      || !existsSync(imageEvidencePath),
    "Set the Edge.js artifact, package image, and build evidence paths"
  );
  test.setTimeout(360_000);

  const resolvedEdgePath = path.resolve(edgeArtifactPath!);
  const resolvedImagePath = path.resolve(imagePath!);
  const buildEvidence = JSON.parse(
    readFileSync(path.resolve(imageEvidencePath!), "utf8")
  ) as BuildEvidence;
  expect(await sha256File(resolvedImagePath)).toBe(
    buildEvidence.image.sha256
  );
  await page.route((url) => url.pathname === "/edgejs.wasm", async (route) => {
    await route.fulfill({
      contentType: "application/wasm",
      path: resolvedEdgePath
    });
  });

  const pageError = page.waitForEvent("pageerror");
  await page.goto(
    "/install-lifecycle-probe.html"
    + "?artifact=/edgejs.wasm"
    + "&image=/openclaw.clawfs"
  );
  const status = page.locator("#status");
  const outcome = await Promise.race([
    expect.poll(
      () => status.getAttribute("data-state"),
      { timeout: 300_000 }
    ).toMatch(/^(?:pass|fail)$/u).then(() => ({ kind: "status" as const })),
    pageError.then((error) => ({ error, kind: "pageerror" as const }))
  ]);
  if (outcome.kind === "pageerror") throw outcome.error;
  if (await status.getAttribute("data-state") === "fail") {
    throw new Error(await page.locator("#result").innerText());
  }

  const evidence = JSON.parse(
    await page.locator("#result").innerText()
  ) as LifecycleEvidence;
  expect(evidence).toMatchObject({
    schemaVersion: 1,
    status: "pass",
    crossOriginIsolated: true,
    image: {
      bytes: buildEvidence.image.bytes,
      files: buildEvidence.image.files,
      payloadBytes: buildEvidence.image.payloadBytes,
      sha256: buildEvidence.image.sha256,
      version: buildEvidence.image.version
    },
    openclaw: {
      name: "openclaw",
      packageJsonSha256:
        buildEvidence.packageContract.packageJsonSha256,
      version: "2026.7.1-2"
    },
    lifecycle: {
      status: "pass",
      executor: "@wasmer/sdk shared Directory + Edge.js QuickJS/WASIX",
      packageFiles: {
        mutated: false
      },
      requiredEffects: {
        packageStateDatabase: {
          hostContractVersion: "2026.7.1-2",
          indexedPlugins: 33,
          migrationVersion: 1,
          refreshReason: "migration",
          path:
            "/openclaw/.clawsembly-install-state/state/openclaw.sqlite"
        }
      }
    }
  });
  expect(evidence.lifecycle.requiredEffects.executions).toHaveLength(3);
  expect(
    evidence.lifecycle.requiredEffects.executions.every(
      (entry) => entry.result.ok && entry.result.code === 0
    )
  ).toBe(true);
  expect(
    evidence.lifecycle.requiredEffects.packageStateDatabase.bytes
  ).toBeGreaterThan(4_096);
  expect(evidence.lifecycle.reviewedNonEffects).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        package: "@google/genai",
        disposition: "effect-proven-without-shell-execution"
      }),
      expect.objectContaining({
        package: "tree-sitter-bash",
        disposition: "not-required-and-not-authorized"
      })
    ])
  );

  writeFileSync(
    testInfo.outputPath("openclaw-install-lifecycle-browser-evidence.json"),
    `${JSON.stringify(evidence, null, 2)}\n`
  );
  await testInfo.attach("openclaw-install-lifecycle-browser-evidence", {
    body: Buffer.from(JSON.stringify(evidence, null, 2)),
    contentType: "application/json"
  });
});
