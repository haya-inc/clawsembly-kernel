import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

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

async function validatePlan(plan) {
  if (
    plan.schemaVersion !== 1
    || typeof plan.bucket !== "string"
    || !Array.isArray(plan.artifacts)
    || plan.artifacts.length !== 2
  ) {
    throw new Error("Invalid Cloudflare upload plan");
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
    for (const artifact of plan.artifacts) {
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
        "public, max-age=31536000, immutable"
      ]);
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

await main();
