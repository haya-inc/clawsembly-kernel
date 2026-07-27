import { chromium, expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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

type PackageStateDatabaseEvidence = {
  bytes: number;
  hostContractVersion: string;
  indexedPlugins: number;
  migrationVersion: number;
  path: string;
  refreshReason: string;
};

type SnapshotIdentity = {
  directories: number;
  files: number;
  generationId: string;
  manifestSha256: string;
  payloadBytes: number;
  rootPath: string;
  storeId: string;
};

type WriteEvidence = {
  artifact: {
    sha256: string;
  };
  browserSessionNonce: string;
  crossOriginIsolated: boolean;
  databaseSha256: string;
  image: BuildEvidence["image"];
  installLifecycle: {
    packageFiles: {
      mutated: boolean;
    };
    requiredEffects: {
      packageStateDatabase: PackageStateDatabaseEvidence;
    };
    status: string;
  };
  openclaw: {
    name: string;
    packageJsonSha256: string;
    version: string;
  };
  packageFilesMutated: boolean;
  phase: "write";
  schemaVersion: number;
  snapshot: SnapshotIdentity & {
    schemaVersion: number;
    status: string;
    storage: {
      persistRequestError?: string;
      persistedAfter: boolean;
      persistedBefore: boolean;
      persistRequestGranted: boolean;
      persistRequestSupported: boolean;
      root: string;
    };
  };
  stateDir: string;
  status: string;
  storeId: string;
};

type ReadEvidence = {
  artifact: {
    sha256: string;
  };
  browserSessionNonce: string;
  crossOriginIsolated: boolean;
  databaseSha256: string;
  image: BuildEvidence["image"];
  lifecycleReexecuted: boolean;
  openclaw: {
    name: string;
    packageJsonSha256: string;
    version: string;
  };
  packageFilesMutated: boolean;
  packageStateDatabase: PackageStateDatabaseEvidence;
  phase: "read";
  restore: SnapshotIdentity & {
    schemaVersion: number;
    status: string;
    verification: string;
  };
  schemaVersion: number;
  stateDir: string;
  status: string;
  storeId: string;
};

type RestoredGatewayEvidence = {
  client: {
    health: {
      ok: boolean;
      plugins: {
        errors: unknown[];
        loaded: string[];
      };
    };
  };
  crossOriginIsolated: boolean;
  gateway: {
    state: string;
  };
  installLifecycle: {
    packageFiles: {
      mutated: boolean;
    };
    requiredEffects: {
      packageStateDatabase: PackageStateDatabaseEvidence;
    };
    status: string;
  };
  persistentStateRestore: SnapshotIdentity & {
    status: string;
    verification: string;
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

async function runPhase<T>(options: {
  artifactPath: string;
  baseURL: string;
  page: Page;
  phase: "write" | "read";
  storeId: string;
}): Promise<T> {
  await options.page.route(
    (url) => url.pathname === "/edgejs.wasm",
    async (route) => {
      await route.fulfill({
        contentType: "application/wasm",
        path: options.artifactPath
      });
    }
  );
  const pageError = options.page.waitForEvent("pageerror");
  await options.page.goto(
    `${options.baseURL}/openclaw-opfs-persistence-probe.html`
    + `?phase=${options.phase}`
    + `&store=${options.storeId}`
    + "&artifact=/edgejs.wasm"
    + "&image=/openclaw.clawfs"
  );
  const status = options.page.locator("#status");
  const outcome = await Promise.race([
    expect.poll(
      () => status.getAttribute("data-state"),
      { timeout: 300_000 }
    ).toMatch(/^(?:pass|fail)$/u).then(() => ({ kind: "status" as const })),
    pageError.then((error) => ({ error, kind: "pageerror" as const }))
  ]);
  if (outcome.kind === "pageerror") throw outcome.error;
  if (await status.getAttribute("data-state") === "fail") {
    throw new Error(await options.page.locator("#result").innerText());
  }
  return JSON.parse(
    await options.page.locator("#result").innerText()
  ) as T;
}

async function runRestoredGatewayHealth(options: {
  artifactPath: string;
  baseURL: string;
  page: Page;
  storeId: string;
}): Promise<RestoredGatewayEvidence> {
  await options.page.route(
    (url) => url.pathname === "/edgejs.wasm",
    async (route) => {
      await route.fulfill({
        contentType: "application/wasm",
        path: options.artifactPath
      });
    }
  );
  const pageError = options.page.waitForEvent("pageerror");
  await options.page.goto(
    `${options.baseURL}/openclaw-gateway-health-probe.html`
    + "?artifact=/edgejs.wasm"
    + "&image=/openclaw.clawfs"
    + "&timeoutMs=300000"
    + `&restoreStore=${options.storeId}`
  );
  const status = options.page.locator("#status");
  const outcome = await Promise.race([
    expect.poll(
      () => status.getAttribute("data-state"),
      { timeout: 360_000 }
    ).toMatch(/^(?:pass|fail)$/u).then(() => ({ kind: "status" as const })),
    pageError.then((error) => ({ error, kind: "pageerror" as const }))
  ]);
  if (outcome.kind === "pageerror") throw outcome.error;
  if (await status.getAttribute("data-state") === "fail") {
    throw new Error(await options.page.locator("#result").innerText());
  }
  return JSON.parse(
    await options.page.locator("#result").innerText()
  ) as RestoredGatewayEvidence;
}

test("official OpenClaw state survives a complete browser restart through OPFS", async ({
  baseURL
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
  test.setTimeout(720_000);
  if (!baseURL) throw new Error("Playwright baseURL is required");

  const resolvedEdgePath = path.resolve(edgeArtifactPath!);
  const resolvedImagePath = path.resolve(imagePath!);
  const edgeSha256 = await sha256File(resolvedEdgePath);
  const buildEvidence = JSON.parse(
    readFileSync(path.resolve(imageEvidencePath!), "utf8")
  ) as BuildEvidence;
  expect(await sha256File(resolvedImagePath)).toBe(
    buildEvidence.image.sha256
  );
  const expectedImage = {
    bytes: buildEvidence.image.bytes,
    files: buildEvidence.image.files,
    payloadBytes: buildEvidence.image.payloadBytes,
    sha256: buildEvidence.image.sha256,
    version: buildEvidence.image.version
  };

  const profileDirectory = await mkdtemp(
    path.join(tmpdir(), "clawsembly-opfs-profile-")
  );
  const storeId = `openclaw-${crypto.randomUUID()}`;
  let writeEvidence: WriteEvidence;
  let readEvidence: ReadEvidence;
  let gatewayHealthEvidence: RestoredGatewayEvidence;
  try {
    const writeContext = await chromium.launchPersistentContext(
      profileDirectory,
      { headless: true }
    );
    try {
      writeEvidence = await runPhase<WriteEvidence>({
        artifactPath: resolvedEdgePath,
        baseURL,
        page: await writeContext.newPage(),
        phase: "write",
        storeId
      });
    } finally {
      await writeContext.close();
    }

    const readContext = await chromium.launchPersistentContext(
      profileDirectory,
      { headless: true }
    );
    try {
      readEvidence = await runPhase<ReadEvidence>({
        artifactPath: resolvedEdgePath,
        baseURL,
        page: await readContext.newPage(),
        phase: "read",
        storeId
      });
    } finally {
      await readContext.close();
    }

    const gatewayContext = await chromium.launchPersistentContext(
      profileDirectory,
      { headless: true }
    );
    try {
      gatewayHealthEvidence = await runRestoredGatewayHealth({
        artifactPath: resolvedEdgePath,
        baseURL,
        page: await gatewayContext.newPage(),
        storeId
      });
    } finally {
      await gatewayContext.close();
    }
  } finally {
    await rm(profileDirectory, { recursive: true, force: true });
  }

  expect(writeEvidence).toMatchObject({
    schemaVersion: 1,
    status: "write-pass",
    phase: "write",
    crossOriginIsolated: true,
    artifact: {
      sha256: edgeSha256
    },
    image: expectedImage,
    openclaw: {
      name: "openclaw",
      packageJsonSha256:
        buildEvidence.packageContract.packageJsonSha256,
      version: "2026.7.1-2"
    },
    stateDir: "/openclaw/.clawsembly-gateway-state",
    storeId,
    packageFilesMutated: false,
    installLifecycle: {
      status: "pass",
      packageFiles: {
        mutated: false
      },
      requiredEffects: {
        packageStateDatabase: {
          hostContractVersion: "2026.7.1-2",
          indexedPlugins: 33,
          migrationVersion: 1,
          refreshReason: "migration"
        }
      }
    },
    snapshot: {
      schemaVersion: 1,
      status: "committed",
      storeId,
      rootPath: "/.clawsembly-gateway-state",
      storage: {
        root: "origin-private-file-system"
      }
    }
  });
  expect(writeEvidence.snapshot.files).toBeGreaterThan(0);
  expect(writeEvidence.snapshot.payloadBytes).toBeGreaterThan(4_096);

  expect(readEvidence).toMatchObject({
    schemaVersion: 1,
    status: "read-pass",
    phase: "read",
    crossOriginIsolated: true,
    artifact: {
      sha256: edgeSha256
    },
    image: expectedImage,
    openclaw: {
      name: "openclaw",
      packageJsonSha256:
        buildEvidence.packageContract.packageJsonSha256,
      version: "2026.7.1-2"
    },
    stateDir: "/openclaw/.clawsembly-gateway-state",
    storeId,
    packageFilesMutated: false,
    lifecycleReexecuted: false,
    packageStateDatabase: {
      hostContractVersion: "2026.7.1-2",
      indexedPlugins: 33,
      migrationVersion: 1,
      refreshReason: "migration"
    },
    restore: {
      schemaVersion: 1,
      status: "restored",
      storeId,
      rootPath: "/.clawsembly-gateway-state",
      verification: "manifest-and-every-file-sha256"
    }
  });
  expect(readEvidence.browserSessionNonce).not.toBe(
    writeEvidence.browserSessionNonce
  );
  expect(readEvidence.databaseSha256).toBe(writeEvidence.databaseSha256);
  expect(readEvidence.packageStateDatabase.bytes).toBe(
    writeEvidence.installLifecycle.requiredEffects
      .packageStateDatabase.bytes
  );
  expect(readEvidence.restore).toMatchObject({
    generationId: writeEvidence.snapshot.generationId,
    manifestSha256: writeEvidence.snapshot.manifestSha256,
    directories: writeEvidence.snapshot.directories,
    files: writeEvidence.snapshot.files,
    payloadBytes: writeEvidence.snapshot.payloadBytes
  });
  expect(gatewayHealthEvidence).toMatchObject({
    schemaVersion: 1,
    status: "gateway-health-pass",
    crossOriginIsolated: true,
    persistentStateRestore: {
      status: "restored",
      storeId,
      generationId: writeEvidence.snapshot.generationId,
      rootPath: "/.clawsembly-gateway-state",
      manifestSha256: writeEvidence.snapshot.manifestSha256,
      verification: "manifest-and-every-file-sha256"
    },
    installLifecycle: {
      status: "restored-from-opfs",
      packageFiles: {
        mutated: false
      },
      requiredEffects: {
        packageStateDatabase: {
          bytes:
            writeEvidence.installLifecycle.requiredEffects
              .packageStateDatabase.bytes,
          hostContractVersion: "2026.7.1-2",
          indexedPlugins: 33,
          migrationVersion: 1,
          refreshReason: "migration"
        }
      }
    },
    gateway: {
      state: "running-at-health-proof"
    },
    client: {
      health: {
        ok: true,
        plugins: {
          loaded: expect.arrayContaining(["memory-core", "ollama"]),
          errors: []
        }
      }
    }
  });

  const evidence = {
    schemaVersion: 1,
    status: "fresh-browser-opfs-recovery-pass",
    claim:
      "A complete browser process restart recovered the exact official "
      + "OpenClaw state from a committed OPFS generation into a new Wasmer "
      + "Directory; new Edge.js processes reopened its SQLite registry and "
      + "completed the official Gateway health RPC without reinstalling.",
    browserSessions: {
      generations: 3,
      fullyClosedBetweenPhases: true,
      samePersistentProfile: true,
      distinctSessionNonces: true
    },
    artifactSha256: edgeSha256,
    imageSha256: buildEvidence.image.sha256,
    write: writeEvidence,
    read: readEvidence,
    restoredGatewayHealth: gatewayHealthEvidence,
    notNorthStarCompletion:
      "This closes the durable fresh-session OPFS recovery gate for the "
      + "pinned OpenClaw release; live authorized TLS provider inference "
      + "remains a separate gate."
  };
  writeFileSync(
    testInfo.outputPath(
      "openclaw-opfs-persistence-browser-evidence.json"
    ),
    `${JSON.stringify(evidence, null, 2)}\n`
  );
  await testInfo.attach("openclaw-opfs-persistence-browser-evidence", {
    body: Buffer.from(JSON.stringify(evidence, null, 2)),
    contentType: "application/json"
  });
});
