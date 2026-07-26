import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  existsSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

type PackageContract = {
  artifact: {
    name: string;
    nodeEngine: string;
    version: string;
  };
  artifactFiles: {
    entry: {
      bytes: number;
      sha256: string;
    };
    launcher: {
      bytes: number;
      sha256: string;
    };
  };
  packageJsonSha256: string;
};

type BuildEvidence = {
  image: {
    bytes: number;
    files: number;
    payloadBytes: number;
    sha256: string;
    version: number;
  };
};

type RuntimeEvidence = {
  blocker?: string;
  crossOriginIsolated: boolean;
  executionMode: string;
  executor: string;
  firstDiagnosticLine?: string;
  image: {
    bytes: number;
    files: number;
    payloadBytes: number;
    version: number;
  };
  invocation: {
    args: string[];
    entry: string;
    harness?: string;
    program: string;
    timeoutMs?: number;
  };
  notSuccessReason: string;
  openclaw: {
    entryBytes: number;
    entrySha256: string;
    launcherBytes: number;
    launcherSha256: string;
    name: string;
    nodeEngine: string;
    packageJsonSha256: string;
    version: string;
  };
  result: {
    code: number;
    ok: boolean;
    stderr: string;
    stdout: string;
  };
  runtime?: {
    node: string;
  };
  schemaVersion: number;
  status: string;
};

const edgeArtifactPath = process.env.CLAWSEMBLY_EDGE_WASIX;
const imagePath = process.env.CLAWSEMBLY_OPENCLAW_IMAGE;
const imageEvidencePath =
  process.env.CLAWSEMBLY_OPENCLAW_IMAGE_EVIDENCE;
const nodeDiagnosticEvidencePath =
  process.env.CLAWSEMBLY_EDGE_NODE_DIAGNOSTIC_EVIDENCE;
const packageContract = JSON.parse(
  readFileSync(
    path.join(process.cwd(), "contracts/openclaw-package.generated.json"),
    "utf8"
  )
) as PackageContract;

async function sha256File(filename: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

test("unmodified OpenClaw dist entry exposes the next browser runtime boundary", async ({
  page
}, testInfo) => {
  test.skip(
    edgeArtifactPath === undefined
      || !existsSync(edgeArtifactPath)
      || imagePath === undefined
      || !existsSync(imagePath)
      || imageEvidencePath === undefined
      || !existsSync(imageEvidencePath),
    "Set CLAWSEMBLY_EDGE_WASIX, CLAWSEMBLY_OPENCLAW_IMAGE, and its evidence"
  );
  test.setTimeout(300_000);

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
  page.on("console", (message) => {
    console.log(`[browser:${message.type()}] ${message.text()}`);
  });

  const pageError = page.waitForEvent("pageerror");
  await page.goto(
    "/package-runtime-probe.html"
    + "?artifact=/edgejs.wasm"
    + "&image=/openclaw.clawfs"
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
  ) as RuntimeEvidence;
  expect(evidence).toMatchObject({
    schemaVersion: 1,
    executionMode: "direct-unmodified-entry-diagnostic",
    crossOriginIsolated: true,
    image: {
      bytes: buildEvidence.image.bytes,
      files: buildEvidence.image.files,
      payloadBytes: buildEvidence.image.payloadBytes,
      version: buildEvidence.image.version
    },
    openclaw: {
      name: packageContract.artifact.name,
      version: packageContract.artifact.version,
      nodeEngine: packageContract.artifact.nodeEngine,
      packageJsonSha256: packageContract.packageJsonSha256,
      launcherBytes: packageContract.artifactFiles.launcher.bytes,
      launcherSha256: packageContract.artifactFiles.launcher.sha256,
      entryBytes: packageContract.artifactFiles.entry.bytes,
      entrySha256: packageContract.artifactFiles.entry.sha256
    },
    invocation: {
      program: "edgejs",
      entry: "/openclaw/dist/entry.js",
      args: ["--version"]
    }
  });
  expect(["blocked", "diagnostic-pass"]).toContain(evidence.status);
  expect(Number.isInteger(evidence.result.code)).toBe(true);
  expect(typeof evidence.result.ok).toBe("boolean");
  expect(typeof evidence.result.stdout).toBe("string");
  expect(typeof evidence.result.stderr).toBe("string");

  const persistedEvidence = {
    ...evidence,
    edgeArtifactSha256: await sha256File(resolvedEdgePath),
    imageSha256: buildEvidence.image.sha256
  };
  writeFileSync(
    testInfo.outputPath("openclaw-package-runtime-browser-evidence.json"),
    `${JSON.stringify(persistedEvidence, null, 2)}\n`
  );
  await testInfo.attach("openclaw-package-runtime-browser-evidence", {
    body: Buffer.from(JSON.stringify(persistedEvidence, null, 2)),
    contentType: "application/json"
  });
});

test("unmodified OpenClaw Gateway path advances beyond the SQLite boundary", async ({
  page
}, testInfo) => {
  test.skip(
    process.env.CLAWSEMBLY_OPENCLAW_GATEWAY_DIAGNOSTIC !== "1"
      || edgeArtifactPath === undefined
      || !existsSync(edgeArtifactPath)
      || imagePath === undefined
      || !existsSync(imagePath)
      || imageEvidencePath === undefined
      || !existsSync(imageEvidencePath)
      || nodeDiagnosticEvidencePath === undefined
      || !existsSync(nodeDiagnosticEvidencePath),
    "Set the Gateway flag, runtime artifacts, and diagnostic-node evidence"
  );
  test.setTimeout(300_000);

  const resolvedEdgePath = path.resolve(edgeArtifactPath!);
  const resolvedImagePath = path.resolve(imagePath!);
  const buildEvidence = JSON.parse(
    readFileSync(path.resolve(imageEvidencePath!), "utf8")
  ) as BuildEvidence;
  expect(await sha256File(resolvedImagePath)).toBe(
    buildEvidence.image.sha256
  );
  const nodeDiagnosticEvidence = JSON.parse(
    readFileSync(path.resolve(nodeDiagnosticEvidencePath!), "utf8")
  ) as {
    diagnostic: {
      nodeVersion: string;
      sha256: string;
    };
    mutation: {
      equalLength: boolean;
      occurrences: number;
    };
    status: string;
  };
  expect(nodeDiagnosticEvidence).toMatchObject({
    status: "diagnostic-only",
    diagnostic: {
      nodeVersion: "24.15.0",
      sha256: await sha256File(resolvedEdgePath)
    },
    mutation: {
      equalLength: true,
      occurrences: 2
    }
  });
  await page.route((url) => url.pathname === "/edgejs.wasm", async (route) => {
    await route.fulfill({
      contentType: "application/wasm",
      path: resolvedEdgePath
    });
  });

  const pageError = page.waitForEvent("pageerror");
  await page.goto(
    "/package-runtime-probe.html"
    + "?artifact=/edgejs.wasm"
    + "&image=/openclaw.clawfs"
    + "&mode=gateway"
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
  ) as RuntimeEvidence;
  expect(evidence).toMatchObject({
    schemaVersion: 1,
    executionMode: "timer-bounded-unmodified-gateway-diagnostic",
    crossOriginIsolated: true,
    runtime: {
      node: "24.15.0"
    },
    image: {
      bytes: buildEvidence.image.bytes,
      files: buildEvidence.image.files,
      payloadBytes: buildEvidence.image.payloadBytes,
      version: buildEvidence.image.version
    },
    openclaw: {
      name: packageContract.artifact.name,
      version: packageContract.artifact.version,
      nodeEngine: packageContract.artifact.nodeEngine,
      packageJsonSha256: packageContract.packageJsonSha256,
      launcherBytes: packageContract.artifactFiles.launcher.bytes,
      launcherSha256: packageContract.artifactFiles.launcher.sha256,
      entryBytes: packageContract.artifactFiles.entry.bytes,
      entrySha256: packageContract.artifactFiles.entry.sha256
    },
    invocation: {
      program: "edgejs",
      entry: "/openclaw/dist/entry.js",
      args: [
        "gateway",
        "run",
        "--dev",
        "--allow-unconfigured",
        "--auth",
        "none",
        "--bind",
        "loopback",
        "--port",
        "18789",
        "--tailscale",
        "off",
        "--ws-log",
        "compact"
      ],
      harness: "timer-bounded dynamic import with guest argv",
      timeoutMs: 12_000
    }
  });
  expect(["blocked", "diagnostic-timeout"]).toContain(evidence.status);
  expect(evidence.blocker).not.toBe("node-sqlite-unavailable-or-unsafe");
  expect(evidence.result.ok).toBe(false);
  expect(Number.isInteger(evidence.result.code)).toBe(true);
  expect(evidence.result.stderr).not.toContain(
    "SQLite support is unavailable or unsafe in this Node runtime."
  );
  if (evidence.status === "diagnostic-timeout") {
    expect(evidence).toMatchObject({
      blocker: "gateway-diagnostic-deadline",
      result: {
        code: 124
      }
    });
    expect(evidence.result.stderr).toContain(
      "CLAWSEMBLY_GATEWAY_DIAGNOSTIC_TIMEOUT="
    );
  }

  const persistedEvidence = {
    ...evidence,
    edgeArtifactSha256: await sha256File(resolvedEdgePath),
    imageSha256: buildEvidence.image.sha256,
    diagnosticNodeVersionEvidence: nodeDiagnosticEvidence
  };
  writeFileSync(
    testInfo.outputPath("openclaw-gateway-runtime-browser-evidence.json"),
    `${JSON.stringify(persistedEvidence, null, 2)}\n`
  );
  await testInfo.attach("openclaw-gateway-runtime-browser-evidence", {
    body: Buffer.from(JSON.stringify(persistedEvidence, null, 2)),
    contentType: "application/json"
  });
});
