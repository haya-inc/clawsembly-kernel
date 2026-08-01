import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validatePlan } from "../scripts/deploy-cloudflare.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function createPlan() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "clawsembly-plan-"));
  const distDirectory = path.join(directory, "dist");
  await mkdir(path.join(distDirectory, "assets"), { recursive: true });
  const manifest = Buffer.from('{"schemaVersion":1}\n');
  const wasmer = Buffer.from("proven-wasmer");
  const manifestPath = path.join(directory, "runtime-manifest.json");
  const deployedManifestPath = path.join(
    distDirectory,
    "runtime-manifest.json"
  );
  const wasmerPath = path.join(distDirectory, "assets", "wasmer.wasm");
  await Promise.all([
    writeFile(manifestPath, manifest),
    writeFile(deployedManifestPath, manifest),
    writeFile(wasmerPath, wasmer)
  ]);
  const artifacts = [];
  for (const name of ["edgejs.wasm", "openclaw.clawfs"]) {
    const bytes = Buffer.from(name);
    const localPath = path.join(directory, name);
    const digest = sha256(bytes);
    await writeFile(localPath, bytes);
    artifacts.push({
      bytes: bytes.length,
      localPath,
      r2Key: `sha256/${digest}/${name}`,
      sha256: digest
    });
  }
  return {
    directory,
    deployedManifestPath,
    plan: {
      schemaVersion: 1,
      bucket: "test-bucket",
      distDirectory,
      manifestPath,
      verifiedWasmerRuntime: {
        path: wasmerPath,
        sha256: sha256(wasmer)
      },
      artifacts
    }
  };
}

test("accepts the exact prepared Cloudflare static bundle", async (context) => {
  const fixture = await createPlan();
  context.after(() => rm(fixture.directory, { recursive: true, force: true }));
  await assert.doesNotReject(validatePlan(fixture.plan));
});

test("rejects a build that removed the prepared runtime manifest", async (context) => {
  const fixture = await createPlan();
  context.after(() => rm(fixture.directory, { recursive: true, force: true }));
  await writeFile(fixture.deployedManifestPath, "<!doctype html>");
  await assert.rejects(
    validatePlan(fixture.plan),
    /prepared runtime manifest/u
  );
});

test("rejects a build that replaced the proven Wasmer runtime", async (context) => {
  const fixture = await createPlan();
  context.after(() => rm(fixture.directory, { recursive: true, force: true }));
  await writeFile(
    fixture.plan.verifiedWasmerRuntime.path,
    "registry-wasmer"
  );
  await assert.rejects(
    validatePlan(fixture.plan),
    /publicly proven Wasmer runtime/u
  );
});
