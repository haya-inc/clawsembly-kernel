import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseClawsemblyFs } from "../src/clawsemblyfs.ts";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const staticAssetLimitBytes = 25 * 1024 * 1024;

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith("--")) {
      throw new Error(`Unexpected argument: ${name}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${name}`);
    }
    values[name.slice(2)] = value;
    index += 1;
  }
  return values;
}

function requiredValue(argumentsMap, name, environmentName) {
  const value = argumentsMap[name] ?? process.env[environmentName];
  if (!value) {
    throw new Error(
      `Provide --${name} or set ${environmentName}`
    );
  }
  return value;
}

async function sha256File(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

function requireEvidence(evidence) {
  const expected = {
    schemaVersion: 7,
    browser: "pass",
    persistentState: "fresh-browser-opfs-recovery-pass",
    healthRpc: "gateway-health-pass",
    agentTurn: "agent-turn-pass",
    workspaceToolTurn: "workspace-tool-turn-pass",
    selfHostedAgentTurn: "self-hosted-agent-turn-pass",
    revocation: "revoked",
    revocationHttpStatus: 403,
    revocationCode: "capability_revoked"
  };
  const actual = {
    schemaVersion: evidence.schemaVersion,
    browser: evidence.browser?.status,
    persistentState: evidence.persistentState?.status,
    healthRpc: evidence.openclawRuntimeProof?.healthRpc?.status,
    agentTurn: evidence.openclawRuntimeProof?.agentTurn?.status,
    workspaceToolTurn:
      evidence.openclawRuntimeProof?.workspaceToolTurn?.status,
    selfHostedAgentTurn:
      evidence.openclawRuntimeProof?.selfHostedAgentTurn?.status,
    revocation:
      evidence.openclawRuntimeProof?.selfHostedAgentTurn
        ?.selfHostedModel?.capabilityBroker?.hostProcess
        ?.revocation?.status,
    revocationHttpStatus:
      evidence.openclawRuntimeProof?.selfHostedAgentTurn
        ?.selfHostedModel?.capabilityBroker?.hostProcess
        ?.rejectedAfterRevocation?.httpStatus,
    revocationCode:
      evidence.openclawRuntimeProof?.selfHostedAgentTurn
        ?.selfHostedModel?.capabilityBroker?.hostProcess
        ?.rejectedAfterRevocation?.body?.error?.code
  };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      "Refusing to deploy incomplete proof evidence:\n"
      + JSON.stringify({ expected, actual }, null, 2)
    );
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ...options.env
      },
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(
        `${command} ${args.join(" ")} failed with `
        + (signal ? `signal ${signal}` : `exit code ${code}`)
      ));
    });
  });
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(filename));
    else if (entry.isFile()) files.push(filename);
  }
  return files;
}

async function findFileWithSha256(directory, expectedSha256) {
  for (const filename of await listFiles(directory)) {
    if (await sha256File(filename) === expectedSha256) return filename;
  }
  return undefined;
}

async function main() {
  const argumentsMap = parseArguments(process.argv.slice(2));
  const proofInputsDirectory = path.resolve(requiredValue(
    argumentsMap,
    "proof-inputs",
    "CLAWSEMBLY_PROOF_INPUTS"
  ));
  const evidencePath = path.resolve(requiredValue(
    argumentsMap,
    "evidence",
    "CLAWSEMBLY_BUILD_EVIDENCE"
  ));
  const release = requiredValue(
    argumentsMap,
    "release",
    "CLAWSEMBLY_RELEASE"
  );
  const sourceCommit = requiredValue(
    argumentsMap,
    "source-commit",
    "CLAWSEMBLY_SOURCE_COMMIT"
  );
  const proofRunUrl = requiredValue(
    argumentsMap,
    "proof-run-url",
    "CLAWSEMBLY_PROOF_RUN_URL"
  );
  const bucket = argumentsMap.bucket
    ?? process.env.CLAWSEMBLY_R2_BUCKET
    ?? "clawsembly-kernel-artifacts";
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/u.test(release)) {
    throw new Error(`Invalid release identifier: ${release}`);
  }
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit)) {
    throw new Error(`Invalid source commit: ${sourceCommit}`);
  }
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/[0-9]+$/u.test(
    proofRunUrl
  )) {
    throw new Error(`Invalid public proof run URL: ${proofRunUrl}`);
  }

  const edgePath = path.join(proofInputsDirectory, "edgejs.wasm");
  const imagePath = path.join(proofInputsDirectory, "openclaw.clawfs");
  const wasmerSdkDirectory = path.join(
    proofInputsDirectory,
    "wasmer-sdk"
  );
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  requireEvidence(evidence);

  const [
    edgeSha256,
    imageSha256,
    evidenceSha256,
    edgeStat,
    imageStat
  ] = await Promise.all([
    sha256File(edgePath),
    sha256File(imagePath),
    sha256File(evidencePath),
    stat(edgePath),
    stat(imagePath)
  ]);
  const expectedEdgeSha256 = evidence.artifact?.wasmSha256;
  const expectedImage = evidence.packageImage?.build?.image;
  if (edgeSha256 !== expectedEdgeSha256) {
    throw new Error(
      `Edge.js SHA-256 mismatch: ${edgeSha256} != ${expectedEdgeSha256}`
    );
  }
  if (
    imageSha256 !== expectedImage?.sha256
    || imageStat.size !== expectedImage?.bytes
  ) {
    throw new Error(
      "OpenClaw package image does not match the public proof evidence"
    );
  }

  const artifactPrefix = `sha256`;
  const manifest = {
    schemaVersion: 1,
    release,
    sourceCommit,
    generatedAt: new Date().toISOString(),
    openclaw: {
      version: evidence.openclaw?.version,
      integrity: evidence.openclaw?.openclawIntegrity
    },
    nodeCompatibility: {
      version: evidence.nodeCompatibility?.browser?.processVersion
    },
    proof: {
      runUrl: proofRunUrl,
      evidenceSha256
    },
    artifacts: {
      edgejs: {
        aliasPath: "/edgejs.wasm",
        publicPath: `/runtime/${release}/edgejs.wasm`,
        r2Key: `${artifactPrefix}/${edgeSha256}/edgejs.wasm`,
        bytes: edgeStat.size,
        sha256: edgeSha256,
        contentType: "application/wasm"
      },
      openclaw: {
        aliasPath: "/openclaw.clawfs",
        publicPath: `/runtime/${release}/openclaw.clawfs`,
        r2Key: `${artifactPrefix}/${imageSha256}/openclaw.clawfs`,
        bytes: imageStat.size,
        sha256: imageSha256,
        contentType: "application/octet-stream"
      }
    }
  };

  const cloudflareDirectory = path.join(repositoryRoot, ".cloudflare");
  const manifestPath = path.join(
    cloudflareDirectory,
    "runtime-manifest.json"
  );
  await mkdir(cloudflareDirectory, { recursive: true });
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`
  );

  await run("npm", ["run", "build"], {
    env: {
      CLAWSEMBLY_WASMER_SDK_DIR: wasmerSdkDirectory
    }
  });

  const distDirectory = path.join(repositoryRoot, "dist");
  await copyFile(
    manifestPath,
    path.join(distDirectory, "runtime-manifest.json")
  );

  const imageBytes = await readFile(imagePath);
  const parsedImage = parseClawsemblyFs(imageBytes);
  const openclawDirectory = path.join(distDirectory, "openclaw");
  await mkdir(openclawDirectory, { recursive: true });
  for (const filename of ["openclaw.mjs", "package.json"]) {
    const bytes = parsedImage.files[`/${filename}`];
    if (!bytes) {
      throw new Error(`Package image is missing /${filename}`);
    }
    await writeFile(path.join(openclawDirectory, filename), bytes);
  }

  const oversizedStaticAssets = [];
  for (const filename of await listFiles(distDirectory)) {
    const fileStat = await stat(filename);
    if (fileStat.size > staticAssetLimitBytes) {
      oversizedStaticAssets.push({
        path: path.relative(distDirectory, filename),
        bytes: fileStat.size
      });
    }
  }
  if (oversizedStaticAssets.length > 0) {
    throw new Error(
      "Cloudflare static asset limit exceeded:\n"
      + JSON.stringify(oversizedStaticAssets, null, 2)
    );
  }

  const expectedWasmerWasmSha256 =
    evidence.browserExecutor?.runtimeWasmSha256;
  const bundledWasmerWasm = await findFileWithSha256(
    distDirectory,
    expectedWasmerWasmSha256
  );
  if (!bundledWasmerWasm) {
    throw new Error(
      "Production bundle does not contain the publicly proven patched "
      + `Wasmer runtime ${expectedWasmerWasmSha256}`
    );
  }

  const uploadPlan = {
    schemaVersion: 1,
    bucket,
    hostname: "clawsembly.yhay81.com",
    manifestPath,
    distDirectory,
    release,
    sourceCommit,
    proofRunUrl,
    verifiedWasmerRuntime: {
      path: bundledWasmerWasm,
      sha256: expectedWasmerWasmSha256
    },
    artifacts: [
      {
        ...manifest.artifacts.edgejs,
        localPath: edgePath
      },
      {
        ...manifest.artifacts.openclaw,
        localPath: imagePath
      }
    ]
  };
  const uploadPlanPath = path.join(
    cloudflareDirectory,
    "upload-plan.json"
  );
  await writeFile(
    uploadPlanPath,
    `${JSON.stringify(uploadPlan, null, 2)}\n`
  );

  console.log(JSON.stringify({
    status: "cloudflare-deploy-prepared",
    release,
    sourceCommit,
    bucket,
    distDirectory,
    manifestPath,
    uploadPlanPath,
    artifacts: uploadPlan.artifacts.map((artifact) => ({
      r2Key: artifact.r2Key,
      bytes: artifact.bytes,
      sha256: artifact.sha256
    })),
    verifiedWasmerRuntime: uploadPlan.verifiedWasmerRuntime
  }, null, 2));
}

await main();
