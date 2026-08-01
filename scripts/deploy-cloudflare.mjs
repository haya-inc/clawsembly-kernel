import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  open,
  readFile,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const wranglerSinglePutLimitBytes = 300 * 1024 * 1024;
const multipartPartBytes = 64 * 1024 * 1024;
const uploaderConfig = "wrangler.r2-uploader.jsonc";
const uploaderWorkerName = "clawsembly-r2-uploader";

function parseArguments(argv) {
  const values = {
    dryRun: false,
    skipUpload: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--dry-run") {
      values.dryRun = true;
      continue;
    }
    if (name === "--skip-upload") {
      values.skipUpload = true;
      continue;
    }
    if (name === "--plan") {
      const value = argv[index + 1];
      if (!value) throw new Error("Missing value for --plan");
      values.plan = value;
      index += 1;
      continue;
    }
    throw new Error(`Unexpected argument: ${name}`);
  }
  return values;
}

async function sha256File(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

function runWrangler(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "npm",
      ["exec", "wrangler", "--", ...args],
      {
        cwd: repositoryRoot,
        env: process.env,
        stdio: "inherit"
      }
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(
        `wrangler ${args.join(" ")} failed with `
        + (signal ? `signal ${signal}` : `exit code ${code}`)
      ));
    });
  });
}

function runWranglerCaptured(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "npm",
      ["exec", "wrangler", "--", ...args],
      {
        cwd: repositoryRoot,
        env: process.env,
        stdio: [
          options.input === undefined ? "ignore" : "pipe",
          "pipe",
          "pipe"
        ]
      }
    );
    let output = "";
    for (const [stream, destination] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr]
    ]) {
      stream.on("data", (chunk) => {
        const text = chunk.toString();
        output += text;
        destination.write(chunk);
      });
    }
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve(output);
        return;
      }
      reject(new Error(
        `wrangler ${args.join(" ")} failed with `
        + (signal ? `signal ${signal}` : `exit code ${code}`)
      ));
    });
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    }
  });
}

function withoutAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/gu, "");
}

async function fetchUploader(url, token, init) {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...init?.headers,
      Authorization: `Bearer ${token}`
    },
    duplex: init?.body === undefined ? undefined : "half"
  });
  if (!response.ok) {
    throw new Error(
      `R2 multipart uploader returned HTTP ${response.status}: `
      + await response.text()
    );
  }
  if (response.status === 204) return undefined;
  return response.json();
}

async function waitForUploader(uploaderUrl, token) {
  const healthUrl = new URL("/healthz", uploaderUrl);
  let lastError;
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    try {
      const result = await fetchUploader(healthUrl, token, {
        method: "GET"
      });
      if (
        result.status === "ok"
        && result.service === "clawsembly-r2-uploader"
      ) {
        return;
      }
      lastError = new Error("Unexpected multipart uploader health response");
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    "Temporary R2 multipart uploader did not become ready",
    { cause: lastError }
  );
}

async function uploadMultipartArtifact(
  artifact,
  uploaderUrl,
  token
) {
  const createResult = await fetchUploader(
    new URL("/create", uploaderUrl),
    token,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        key: artifact.r2Key,
        contentType: artifact.contentType
      })
    }
  );
  const uploadId = createResult.uploadId;
  const parts = [];
  const file = await open(artifact.localPath, "r");
  try {
    for (
      let offset = 0, partNumber = 1;
      offset < artifact.bytes;
      offset += multipartPartBytes, partNumber += 1
    ) {
      const length = Math.min(
        multipartPartBytes,
        artifact.bytes - offset
      );
      const bytes = new Uint8Array(length);
      const { bytesRead } = await file.read(bytes, 0, length, offset);
      if (bytesRead !== length) {
        throw new Error(
          `Short read for ${artifact.localPath} at byte ${offset}`
        );
      }
      const partUrl = new URL("/part", uploaderUrl);
      partUrl.searchParams.set("key", artifact.r2Key);
      partUrl.searchParams.set("uploadId", uploadId);
      partUrl.searchParams.set("partNumber", String(partNumber));
      parts.push(await fetchUploader(partUrl, token, {
        method: "PUT",
        headers: {
          "Content-Length": String(length),
          "Content-Type": "application/octet-stream"
        },
        body: bytes
      }));
      console.log(JSON.stringify({
        status: "r2-multipart-part-uploaded",
        r2Key: artifact.r2Key,
        partNumber,
        bytes: length
      }));
    }
    const completeResult = await fetchUploader(
      new URL("/complete", uploaderUrl),
      token,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          key: artifact.r2Key,
          uploadId,
          parts
        })
      }
    );
    if (
      completeResult.key !== artifact.r2Key
      || completeResult.size !== artifact.bytes
    ) {
      throw new Error(
        `Completed R2 object does not match ${artifact.r2Key}`
      );
    }
  } catch (error) {
    await fetchUploader(new URL("/abort", uploaderUrl), token, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        key: artifact.r2Key,
        uploadId
      })
    }).catch((abortError) => {
      console.error("Failed to abort multipart upload", abortError);
    });
    throw error;
  } finally {
    await file.close();
  }
}

async function uploadLargeArtifacts(artifacts) {
  const token = randomBytes(32).toString("hex");
  const secretsPath = path.join(
    repositoryRoot,
    ".cloudflare",
    "r2-uploader-secrets.env"
  );
  await writeFile(
    secretsPath,
    `CLAWSEMBLY_UPLOAD_TOKEN=${token}\n`,
    { mode: 0o600 }
  );
  let deployed = false;
  try {
    const output = await runWranglerCaptured([
      "deploy",
      "--config",
      uploaderConfig,
      "--secrets-file",
      secretsPath,
      "--message",
      "Temporary content-addressed R2 multipart upload"
    ]);
    deployed = true;
    const matches = [
      ...withoutAnsi(output).matchAll(
        /https:\/\/[a-z0-9.-]+\.workers\.dev/giu
      )
    ];
    const uploaderUrl = process.env.CLAWSEMBLY_R2_UPLOADER_URL
      ?? matches.at(-1)?.[0];
    if (!uploaderUrl) {
      throw new Error(
        "Wrangler did not report the temporary uploader URL; set "
        + "CLAWSEMBLY_R2_UPLOADER_URL explicitly"
      );
    }
    await waitForUploader(uploaderUrl, token);
    for (const artifact of artifacts) {
      await uploadMultipartArtifact(artifact, uploaderUrl, token);
    }
  } finally {
    await unlink(secretsPath).catch(() => {});
    if (deployed) {
      await runWranglerCaptured([
        "delete",
        uploaderWorkerName,
        "--force"
      ]);
    }
  }
}

export async function validatePlan(plan) {
  if (
    plan.schemaVersion !== 1
    || typeof plan.bucket !== "string"
    || typeof plan.distDirectory !== "string"
    || typeof plan.manifestPath !== "string"
    || typeof plan.verifiedWasmerRuntime?.path !== "string"
    || typeof plan.verifiedWasmerRuntime?.sha256 !== "string"
    || !Array.isArray(plan.artifacts)
    || plan.artifacts.length !== 2
  ) {
    throw new Error("Invalid Cloudflare upload plan");
  }

  const distDirectory = path.resolve(plan.distDirectory);
  const deployedManifestPath = path.join(
    distDirectory,
    "runtime-manifest.json"
  );
  const [preparedManifestSha256, deployedManifestSha256] = await Promise.all([
    sha256File(plan.manifestPath),
    sha256File(deployedManifestPath)
  ]);
  if (preparedManifestSha256 !== deployedManifestSha256) {
    throw new Error(
      "Cloudflare static bundle no longer contains its prepared runtime "
      + "manifest; run npm run cloudflare:prepare again"
    );
  }

  const wasmerRuntimePath = path.resolve(plan.verifiedWasmerRuntime.path);
  const relativeWasmerPath = path.relative(distDirectory, wasmerRuntimePath);
  if (
    relativeWasmerPath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeWasmerPath)
    || await sha256File(wasmerRuntimePath)
      !== plan.verifiedWasmerRuntime.sha256
  ) {
    throw new Error(
      "Cloudflare static bundle no longer contains its publicly proven "
      + "Wasmer runtime; run npm run cloudflare:prepare again"
    );
  }

  for (const artifact of plan.artifacts) {
    const artifactStat = await stat(artifact.localPath);
    if (
      artifactStat.size !== artifact.bytes
      || await sha256File(artifact.localPath) !== artifact.sha256
      || !artifact.r2Key.includes(artifact.sha256)
    ) {
      throw new Error(
        `Upload artifact no longer matches its plan: ${artifact.localPath}`
      );
    }
  }
}

async function main() {
  const argumentsMap = parseArguments(process.argv.slice(2));
  const planPath = path.resolve(
    argumentsMap.plan
    ?? process.env.CLAWSEMBLY_CLOUDFLARE_PLAN
    ?? path.join(repositoryRoot, ".cloudflare", "upload-plan.json")
  );
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  await validatePlan(plan);

  if (!argumentsMap.skipUpload && !argumentsMap.dryRun) {
    const regularArtifacts = plan.artifacts.filter(
      (artifact) => artifact.bytes <= wranglerSinglePutLimitBytes
    );
    const largeArtifacts = plan.artifacts.filter(
      (artifact) => artifact.bytes > wranglerSinglePutLimitBytes
    );
    for (const artifact of regularArtifacts) {
      await runWrangler([
        "r2",
        "object",
        "put",
        `${plan.bucket}/${artifact.r2Key}`,
        "--remote",
        "--file",
        artifact.localPath,
        "--content-type",
        artifact.contentType,
        "--cache-control",
        "public, max-age=31536000, immutable, no-transform"
      ]);
    }
    if (largeArtifacts.length > 0) {
      await uploadLargeArtifacts(largeArtifacts);
    }
  }

  await runWrangler([
    "deploy",
    "--message",
    `Deploy ${plan.release} runtime proven by ${plan.proofRunUrl}`,
    ...(argumentsMap.dryRun ? ["--dry-run"] : [])
  ]);

  console.log(JSON.stringify({
    status: argumentsMap.dryRun
      ? "cloudflare-deploy-dry-run-pass"
      : "cloudflare-deployed",
    hostname: plan.hostname,
    release: plan.release,
    sourceCommit: plan.sourceCommit,
    proofRunUrl: plan.proofRunUrl,
    uploaded: !argumentsMap.skipUpload && !argumentsMap.dryRun,
    artifacts: plan.artifacts.map((artifact) => ({
      r2Key: artifact.r2Key,
      bytes: artifact.bytes,
      sha256: artifact.sha256
    }))
  }, null, 2));
}

if (
  process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
