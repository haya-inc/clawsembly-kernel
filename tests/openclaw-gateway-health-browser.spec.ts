import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

type PackageContract = {
  artifact: {
    name: string;
    nodeEngine: string;
    version: string;
  };
  artifactFiles: {
    entry: {
      sha256: string;
    };
    launcher: {
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

type BrowserBuildContract = {
  nodeCompatibility: {
    officialNodeBinary: boolean;
    profile: string;
    reportedVersion: string;
    sourceBaselineVersion: string;
  };
};

type GatewayHealthEvidence = {
  artifact?: {
    bytes: number;
    sha256: string;
  };
  blocker?: string;
  claim: string;
  client?: {
    args: string[];
    attempts: Array<{
      attempt: number;
      completion: string;
      health?: unknown;
      outcome: string;
      result: {
        code: number | null;
        ok: boolean;
        stderr: string;
        stdout: string;
      };
      stateRoot: string;
    }>;
    completion: string;
    distinctGuestProcess: boolean;
    health?: unknown;
    healthParseError?: string;
    maxAttempts: number;
    result: {
      code: number | null;
      ok: boolean;
      stderr: string;
      stdout: string;
    };
    selectedAttempt: number;
  };
  crossOriginIsolated: boolean;
  executor: string;
  gateway: {
    args: string[];
    clientLaunchElapsedMs?: number;
    clientLaunchMarker?: string;
    readinessMarker?: string;
    readyElapsedMs?: number;
    state?: string;
    stderr?: string;
    stdout?: string;
  };
  image?: {
    bytes: number;
    files: number;
    payloadBytes: number;
    sha256: string;
    version: number;
  };
  installLifecycle?: {
    packageFiles: {
      mutated: boolean;
    };
    requiredEffects: {
      packageStateDatabase: {
        hostContractVersion: string;
        indexedPlugins: number;
      };
    };
    status: string;
  };
  isolation?: {
    clientRetryFilesystem: string;
    clientStateRootPattern: string;
    distinctFilesystemInstances: boolean;
    gatewayStateRoot: string;
    sharedRuntimeNetworkNamespace: boolean;
  };
  launchHarness?: {
    client: string;
    clientLaunchMarker: string;
    gateway: string;
    officialEntrypoint: string;
    openclawPackageFilesMutated: boolean;
  };
  network?: {
    externalEgress: string;
    namespace: string;
    url: string;
  };
  notNorthStarCompletion?: string;
  openclaw?: {
    entrySha256: string;
    launcherSha256: string;
    name: string;
    nodeEngine: string;
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
const proofTimeoutMs = Number(
  process.env.CLAWSEMBLY_OPENCLAW_GATEWAY_HEALTH_TIMEOUT_MS ?? "240000"
);
const proofRetries = Number(
  process.env.CLAWSEMBLY_OPENCLAW_GATEWAY_HEALTH_RETRIES ?? "3"
);
if (
  !Number.isSafeInteger(proofTimeoutMs)
  || proofTimeoutMs < 60_000
  || proofTimeoutMs > 300_000
) {
  throw new Error(
    "CLAWSEMBLY_OPENCLAW_GATEWAY_HEALTH_TIMEOUT_MS must be "
    + "an integer from 60000 through 300000"
  );
}
if (
  !Number.isSafeInteger(proofRetries)
  || proofRetries < 0
  || proofRetries > 3
) {
  throw new Error(
    "CLAWSEMBLY_OPENCLAW_GATEWAY_HEALTH_RETRIES must be "
    + "an integer from 0 through 3"
  );
}
const packageContract = JSON.parse(
  readFileSync(
    path.join(process.cwd(), "contracts/openclaw-package.generated.json"),
    "utf8"
  )
) as PackageContract;
const browserBuildContract = JSON.parse(
  readFileSync(
    path.join(process.cwd(), "contracts/edgejs-browser-build.json"),
    "utf8"
  )
) as BrowserBuildContract;

async function sha256File(filename: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

test.describe.configure({ retries: proofRetries });

test("official OpenClaw client attempts authenticated Gateway health over browser loopback", async ({
  page
}, testInfo) => {
  test.skip(
    process.env.CLAWSEMBLY_OPENCLAW_GATEWAY_HEALTH_PROOF !== "1"
      || edgeArtifactPath === undefined
      || !existsSync(edgeArtifactPath)
      || imagePath === undefined
      || !existsSync(imagePath)
      || imageEvidencePath === undefined
      || !existsSync(imageEvidencePath),
    "Set the Gateway health flag, runtime artifacts, and evidence paths"
  );
  test.setTimeout(proofTimeoutMs + 120_000);

  const resolvedEdgePath = path.resolve(edgeArtifactPath!);
  const resolvedImagePath = path.resolve(imagePath!);
  const edgeSha256 = await sha256File(resolvedEdgePath);
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
    "/openclaw-gateway-health-probe.html"
    + "?artifact=/edgejs.wasm"
    + "&image=/openclaw.clawfs"
    + `&timeoutMs=${proofTimeoutMs}`
  );
  const status = page.locator("#status");
  const outcome = await Promise.race([
    expect.poll(
      () => status.getAttribute("data-state"),
      { timeout: proofTimeoutMs + 60_000 }
    ).toMatch(/^(?:pass|fail)$/u).then(() => ({ kind: "status" as const })),
    pageError.then((error) => ({ error, kind: "pageerror" as const }))
  ]);
  if (outcome.kind === "pageerror") throw outcome.error;
  if (await status.getAttribute("data-state") === "fail") {
    throw new Error(await page.locator("#result").innerText());
  }

  const evidence = JSON.parse(
    await page.locator("#result").innerText()
  ) as GatewayHealthEvidence;
  const persistedEvidence = {
    ...evidence,
    edgeArtifactSha256: edgeSha256,
    imageSha256: buildEvidence.image.sha256,
    nodeCompatibilityContract: browserBuildContract.nodeCompatibility
  };
  writeFileSync(
    testInfo.outputPath("openclaw-gateway-health-browser-evidence.json"),
    `${JSON.stringify(persistedEvidence, null, 2)}\n`
  );
  await testInfo.attach("openclaw-gateway-health-browser-evidence", {
    body: Buffer.from(JSON.stringify(persistedEvidence, null, 2)),
    contentType: "application/json"
  });
  console.info(JSON.stringify({
    evidenceFile: testInfo.outputPath(
      "openclaw-gateway-health-browser-evidence.json"
    ),
    status: evidence.status,
    blocker: evidence.blocker,
    gateway: {
      readyElapsedMs: evidence.gateway.readyElapsedMs,
      clientLaunchElapsedMs: evidence.gateway.clientLaunchElapsedMs,
      state: evidence.gateway.state
    },
    client: evidence.client
      ? {
          selectedAttempt: evidence.client.selectedAttempt,
          completion: evidence.client.completion,
          attempts: evidence.client.attempts.map((attempt) => ({
            attempt: attempt.attempt,
            outcome: attempt.outcome,
            completion: attempt.completion,
            code: attempt.result.code,
            ok: attempt.result.ok,
            stdoutBytes: Buffer.byteLength(attempt.result.stdout),
            stderrBytes: Buffer.byteLength(attempt.result.stderr)
          }))
        }
      : undefined
  }));

  expect(evidence).toMatchObject({
    schemaVersion: 1,
    crossOriginIsolated: true,
    executor: "@wasmer/sdk + Edge.js QuickJS/WASIX",
    installLifecycle: {
      status: "pass",
      packageFiles: {
        mutated: false
      },
      requiredEffects: {
        packageStateDatabase: {
          hostContractVersion: packageContract.artifact.version,
          indexedPlugins: 33
        }
      }
    },
    gateway: {
      args: [
        "gateway",
        "run",
        "--allow-unconfigured",
        "--auth",
        "token",
        "--bind",
        "loopback",
        "--port",
        "18789",
        "--tailscale",
        "off",
        "--verbose",
        "--ws-log",
        "full"
      ]
    }
  });
  expect(evidence.status).toBe("gateway-health-pass");
  expect(evidence).toMatchObject({
    artifact: {
      sha256: edgeSha256
    },
    image: {
      bytes: buildEvidence.image.bytes,
      files: buildEvidence.image.files,
      payloadBytes: buildEvidence.image.payloadBytes,
      sha256: buildEvidence.image.sha256,
      version: buildEvidence.image.version
    },
    openclaw: {
      name: packageContract.artifact.name,
      version: packageContract.artifact.version,
      nodeEngine: packageContract.artifact.nodeEngine,
      packageJsonSha256: packageContract.packageJsonSha256,
      launcherSha256: packageContract.artifactFiles.launcher.sha256,
      entrySha256: packageContract.artifactFiles.entry.sha256
    },
    network: {
      namespace: "browser-local-loopback",
      url: "ws://127.0.0.1:18789",
      externalEgress: "denied-by-default"
    },
      isolation: {
        sharedRuntimeNetworkNamespace: true,
        distinctFilesystemInstances: true,
        clientRetryFilesystem:
          "one prebuilt filesystem reused sequentially",
        gatewayStateRoot: "/openclaw/.clawsembly-gateway-state",
        clientStateRootPattern:
          "/openclaw/.clawsembly-client-state-{attempt}"
    },
    launchHarness: {
      officialEntrypoint: "/openclaw/dist/entry.js",
      openclawPackageFilesMutated: false,
      clientLaunchMarker: "agent runtime plugins pre-warmed"
    },
    gateway: {
      readinessMarker: "http server listening",
      clientLaunchMarker: "agent runtime plugins pre-warmed"
    },
    client: {
      args: [
        "gateway",
        "call",
        "health",
        "--url",
        "ws://127.0.0.1:18789",
        "--token",
        "clawsembly-diagnostic-non-secret-token",
        "--timeout",
        "60000",
        "--json"
      ],
      distinctGuestProcess: true,
      maxAttempts: 3
    }
  });
  expect([
    "client-exit-zero",
    "health-output-observed"
  ]).toContain(evidence.client?.completion);
  expect(evidence.client?.health).toMatchObject({
    ok: true,
    plugins: {
      loaded: expect.arrayContaining(["memory-core", "ollama"]),
      errors: []
    }
  });
  expect(evidence.gateway.stdout).toContain("http server listening");
  expect(evidence.gateway.stdout).toContain(
    "agent runtime plugins pre-warmed"
  );
  expect(evidence.gateway.clientLaunchElapsedMs).toBeGreaterThanOrEqual(
    evidence.gateway.readyElapsedMs ?? 0
  );
  expect(evidence.gateway.stdout).toContain("[ws] ← connect client=cli");
  expect(evidence.gateway.stdout).toContain("[ws] → hello-ok methods=");
  expect(evidence.gateway.stdout).toContain("[ws] ← req health");
  expect(evidence.gateway.stdout).toContain("[ws] → res ✓ health");
  expect([
    "running-at-health-proof",
    "exited-after-health-output"
  ]).toContain(evidence.gateway.state);
  expect(evidence.client?.healthParseError).toBeUndefined();
  expect(evidence.client?.attempts.length).toBeGreaterThanOrEqual(1);
  expect(evidence.client?.attempts.length).toBeLessThanOrEqual(3);
  expect(evidence.client?.selectedAttempt).toBeGreaterThanOrEqual(1);
  expect(evidence.notNorthStarCompletion).toContain(
    "agent-turn"
  );
  expect(evidence.notNorthStarCompletion).not.toContain("relabeled");

});
