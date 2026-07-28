#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import process from "node:process";

const contractPath = new URL(
  "../contracts/openclaw-artifact.json",
  import.meta.url
);
const current = JSON.parse(await readFile(contractPath, "utf8"));
const response = await fetch("https://registry.npmjs.org/openclaw/latest", {
  headers: {
    accept: "application/json",
    "user-agent": "clawsembly-kernel-update-check/1"
  },
  redirect: "error",
  signal: AbortSignal.timeout(30_000)
});
if (!response.ok) {
  throw new Error(`npm registry returned HTTP ${response.status}`);
}
const latest = await response.json();
if (
  latest.name !== "openclaw"
  || typeof latest.version !== "string"
  || typeof latest.dist?.integrity !== "string"
  || typeof latest.dist?.tarball !== "string"
) {
  throw new Error("npm latest metadata is missing required OpenClaw fields");
}

const updateAvailable = latest.version !== current.version;
const report = {
  schemaVersion: 1,
  status: updateAvailable ? "update-available" : "current",
  checkedAt: new Date().toISOString(),
  current: {
    version: current.version,
    integrity: current.integrity,
    nodeEngine: current.nodeEngine,
    tarball: current.tarball
  },
  latest: {
    version: latest.version,
    integrity: latest.dist.integrity,
    nodeEngine: latest.engines?.node ?? null,
    publishedTarball: latest.dist.tarball
  },
  updateAvailable,
  requiredValidation: [
    "regenerate the artifact-derived SQLite contract",
    "regenerate the complete package contract",
    "run the full source-built browser proof",
    "review newly reached Node APIs, lifecycle effects, tools, and plugins",
    "merge only version-bound public evidence"
  ]
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

if (process.argv.includes("--fail-if-update") && updateAvailable) {
  process.exitCode = 10;
}
