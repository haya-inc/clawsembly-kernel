import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const edgeContract = readJson(path.join(repositoryRoot, "contracts/edgejs-artifact.json"));
const browserBuildContract = readJson(
  path.join(repositoryRoot, "contracts/edgejs-browser-build.json")
);
const openClawContract = readJson(path.join(repositoryRoot, "contracts/openclaw-artifact.json"));
const sqliteContract = readJson(
  path.join(repositoryRoot, "contracts/openclaw-sqlite-contract.generated.json")
);
const packageLock = readJson(path.join(repositoryRoot, "package-lock.json"));
const sqlitePackage = packageLock.packages["node_modules/@sqlite.org/sqlite-wasm"];

const platformKey = `${process.platform}-${process.arch}`;
const edgeAsset = edgeContract.distribution.assets[platformKey];
if (!edgeAsset) {
  throw new Error(`No pinned native Edge.js artifact for ${platformKey}`);
}

const cacheRoot = path.resolve(
  process.env.CLAWSEMBLY_ARTIFACT_CACHE
    ?? path.join(os.tmpdir(), "clawsembly-kernel-artifacts")
);
mkdirSync(cacheRoot, { recursive: true });
const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "clawsembly-edgejs-proof-"));
let keepTemporaryRoot = process.env.CLAWSEMBLY_KEEP_TEMP === "1";

try {
  const edgeArchive = await resolveArtifact({
    algorithm: "sha256",
    cacheName: `${edgeAsset.sha256}-${edgeAsset.filename}`,
    expectedDigest: edgeAsset.sha256,
    expectedSize: edgeAsset.size,
    overridePath: process.env.CLAWSEMBLY_EDGE_ARCHIVE,
    url: edgeAsset.url
  });
  const openClawArchive = await resolveArtifact({
    algorithm: "sha512",
    cacheName: `${openClawContract.name}-${openClawContract.version}.tgz`,
    expectedDigest: sriDigest(openClawContract.integrity, "sha512"),
    overridePath: process.env.CLAWSEMBLY_OPENCLAW_ARCHIVE,
    url: openClawContract.tarball
  });

  const edgeRoot = path.join(temporaryRoot, "edge");
  mkdirSync(edgeRoot);
  execFileSync("unzip", ["-q", edgeArchive, "-d", edgeRoot]);
  const edgeExecutable = path.join(edgeRoot, edgeAsset.executable);
  chmodSync(edgeExecutable, 0o755);

  const artifactRoot = path.join(temporaryRoot, "artifact");
  mkdirSync(artifactRoot);
  execFileSync("tar", ["-xzf", openClawArchive, "-C", artifactRoot]);
  const openClawPackageRoot = path.join(artifactRoot, "package");
  const installedPackage = readJson(path.join(openClawPackageRoot, "package.json"));
  assert.equal(installedPackage.name, openClawContract.name);
  assert.equal(installedPackage.version, openClawContract.version);

  const shrinkwrap = readJson(path.join(openClawPackageRoot, "npm-shrinkwrap.json"));
  const externalPackages = discoverArtifactImportPackages(
    openClawPackageRoot,
    sqliteContract.stateSchema.sourceFile
  );
  const supportPackages = [];
  for (const packageName of externalPackages) {
    const lockPath = `node_modules/${packageName}`;
    const packageLockEntry = shrinkwrap.packages?.[lockPath];
    assert.ok(packageLockEntry, `OpenClaw shrinkwrap has no entry for ${packageName}`);
    const packageArchive = await resolveArtifact({
      algorithm: "sha512",
      cacheName: `${packageName.replaceAll("/", "-")}-${packageLockEntry.version}.tgz`,
      expectedDigest: sriDigest(packageLockEntry.integrity, "sha512"),
      url: packageLockEntry.resolved
    });
    const packageRoot = path.join(openClawPackageRoot, lockPath);
    mkdirSync(packageRoot, { recursive: true });
    execFileSync("tar", [
      "-xzf",
      packageArchive,
      "-C",
      packageRoot,
      "--strip-components=1"
    ]);
    supportPackages.push({
      name: packageName,
      version: packageLockEntry.version,
      integrity: packageLockEntry.integrity
    });
  }

  const probeRoot = path.join(temporaryRoot, "probe");
  mkdirSync(probeRoot);
  copyFileSync(
    path.join(repositoryRoot, "runtime/edgejs/bootstrap.mjs"),
    path.join(probeRoot, "bootstrap.mjs")
  );
  copyFileSync(
    path.join(repositoryRoot, "runtime/edgejs/node-sqlite-personality.mjs"),
    path.join(probeRoot, "node-sqlite-personality.mjs")
  );
  copyFileSync(
    path.join(repositoryRoot, "tests/fixtures/edgejs-openclaw-state-probe.mjs"),
    path.join(probeRoot, "edgejs-openclaw-state-probe.mjs")
  );
  copyFileSync(
    path.join(repositoryRoot, "node_modules/@sqlite.org/sqlite-wasm/dist/node.mjs"),
    path.join(probeRoot, "sqlite3-node.mjs")
  );
  copyFileSync(
    path.join(repositoryRoot, "node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm"),
    path.join(probeRoot, "sqlite3.wasm")
  );

  const stateRoot = path.join(temporaryRoot, "state-capability");
  mkdirSync(stateRoot);
  const statePath = path.join(stateRoot, "openclaw.sqlite3");
  const probePath = path.join(probeRoot, "edgejs-openclaw-state-probe.mjs");
  const writeEvidence = runEdgeProbe(
    edgeExecutable,
    probePath,
    "write",
    statePath,
    openClawPackageRoot
  );
  const firstProcessDatabaseSha256 = hashFile(statePath, "sha256", "hex");
  const readEvidence = runEdgeProbe(
    edgeExecutable,
    probePath,
    "read",
    statePath,
    openClawPackageRoot
  );

  verifyEvidence(writeEvidence, "write");
  verifyEvidence(readEvidence, "read");
  assert.notEqual(
    writeEvidence.runtime.pid,
    readEvidence.runtime.pid,
    "Persistence proof did not use a fresh Edge.js process"
  );
  assert.deepEqual(
    readEvidence.persistence.evidenceRow,
    writeEvidence.persistence.evidenceRow,
    "Fresh Edge.js process did not recover the prior OpenClaw state"
  );

  const proof = {
    schemaVersion: 1,
    claim: "The exact unmodified OpenClaw state artifact resolved and executed the kernel node:sqlite personality inside Edge.js, then recovered state in a fresh Edge.js process.",
    artifacts: {
      edgejs: {
        sourceCommit: edgeContract.source.commit,
        asset: edgeAsset.filename,
        archiveSha256: edgeAsset.sha256,
        runtime: edgeContract.runtime
      },
      openclaw: {
        name: openClawContract.name,
        version: openClawContract.version,
        integrity: openClawContract.integrity,
        stateChunk: sqliteContract.stateSchema.sourceFile,
        stateChunkSha256: sqliteContract.stateSchema.sourceFileSha256
      },
      sqliteWasm: {
        version: sqlitePackage.version,
        integrity: sqlitePackage.integrity
      },
      supportPackages
    },
    execution: {
      writeProcess: writeEvidence,
      freshReadProcess: readEvidence,
      distinctEdgeProcesses: true,
      firstProcessDatabaseSha256
    },
    remainingGates: {
      fullOpenClawEntrypoint: {
        satisfied: false,
        actualNodeVersion: edgeContract.runtime.nodeVersion,
        requiredNodeEngine: openClawContract.nodeEngine,
        reason: "The pinned Edge.js runtime is older than OpenClaw's Node 24.15.0 safety floor."
      },
      browserWasixExecution: {
        satisfied: false,
        runtimeProvider: browserBuildContract.runtimeProvider,
        edgeSourceCommit: browserBuildContract.upstream.commit,
        browserExecutorSourceCommit: browserBuildContract.browserExecutor.upstream.commit,
        reason: "This native-process proof does not execute the self-built QuickJS Edge.js and patched Wasmer JS pair in Chromium.",
        disposition: "Build and execute the pair pinned by contracts/edgejs-browser-build.json in .github/workflows/edgejs-wasix-build.yml."
      }
    }
  };
  console.log(JSON.stringify(proof, null, 2));
} catch (error) {
  keepTemporaryRoot = true;
  console.error(`Edge.js proof workspace retained at ${temporaryRoot}`);
  throw error;
} finally {
  if (!keepTemporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
}

function readJson(filename) {
  return JSON.parse(readFileSync(filename, "utf8"));
}

function sriDigest(integrity, algorithm) {
  const [actualAlgorithm, encoded] = integrity.split("-", 2);
  assert.equal(actualAlgorithm, algorithm, `Expected ${algorithm} integrity`);
  return Buffer.from(encoded, "base64").toString("hex");
}

function discoverArtifactImportPackages(packageRoot, entryRelativePath) {
  const pending = [entryRelativePath];
  const visited = new Set();
  const packages = new Set();
  const staticImportPattern = /\b(?:import|export)\s+(?:[^"'`;]*?\s+from\s+)?["']([^"']+)["']/gu;
  const literalRequirePattern = /\brequire\(\s*["']([^"']+)["']\s*\)/gu;

  while (pending.length > 0) {
    const relativePath = pending.pop();
    if (visited.has(relativePath)) continue;
    visited.add(relativePath);
    const filename = path.join(packageRoot, relativePath);
    const source = readFileSync(filename, "utf8");
    for (const pattern of [staticImportPattern, literalRequirePattern]) {
      pattern.lastIndex = 0;
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1];
        if (specifier.startsWith("./") || specifier.startsWith("../")) {
          const dependencyPath = path.normalize(
            path.join(path.dirname(relativePath), specifier)
          );
          if (existsSync(path.join(packageRoot, dependencyPath))) {
            pending.push(dependencyPath);
          }
        } else if (!specifier.startsWith("node:")) {
          packages.add(packageNameFromSpecifier(specifier));
        }
      }
    }
  }
  return [...packages].sort();
}

function packageNameFromSpecifier(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

function hashFile(filename, algorithm, encoding = "hex") {
  return createHash(algorithm).update(readFileSync(filename)).digest(encoding);
}

function verifyArtifact(filename, options) {
  if (!existsSync(filename)) return false;
  if (options.expectedSize !== undefined && statSync(filename).size !== options.expectedSize) {
    return false;
  }
  return hashFile(filename, options.algorithm) === options.expectedDigest;
}

async function resolveArtifact(options) {
  if (options.overridePath) {
    const overridePath = path.resolve(options.overridePath);
    if (!verifyArtifact(overridePath, options)) {
      throw new Error(`Artifact override failed integrity verification: ${overridePath}`);
    }
    return overridePath;
  }

  const cachedPath = path.join(cacheRoot, options.cacheName);
  if (verifyArtifact(cachedPath, options)) return cachedPath;
  if (existsSync(cachedPath)) unlinkSync(cachedPath);

  const response = await fetch(options.url);
  if (!response.ok) {
    throw new Error(`Artifact download failed (${response.status}): ${options.url}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const temporaryPath = `${cachedPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, bytes, { mode: 0o600 });
  if (!verifyArtifact(temporaryPath, options)) {
    unlinkSync(temporaryPath);
    throw new Error(`Downloaded artifact failed integrity verification: ${options.url}`);
  }
  renameSync(temporaryPath, cachedPath);
  return cachedPath;
}

function runEdgeProbe(edgeExecutable, probePath, phase, statePath, openClawPackageRoot) {
  const result = spawnSync(
    edgeExecutable,
    [probePath, phase, statePath, openClawPackageRoot],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        NO_COLOR: "1"
      },
      maxBuffer: 20 * 1024 * 1024,
      timeout: 120_000
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Edge.js ${phase} probe failed with status ${result.status}\n`
      + `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
  }
  const evidenceLine = result.stdout
    .split(/\r?\n/u)
    .find((line) => line.startsWith("CLAWSEMBLY_EVIDENCE="));
  if (!evidenceLine) {
    throw new Error(`Edge.js ${phase} probe emitted no evidence\n${result.stdout}`);
  }
  return JSON.parse(evidenceLine.slice("CLAWSEMBLY_EVIDENCE=".length));
}

function verifyEvidence(evidence, phase) {
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.phase, phase);
  assert.equal(evidence.artifact.name, openClawContract.name);
  assert.equal(evidence.artifact.version, openClawContract.version);
  assert.equal(evidence.artifact.stateChunk, sqliteContract.stateSchema.sourceFile);
  assert.equal(
    evidence.artifact.stateChunkSha256,
    sqliteContract.stateSchema.sourceFileSha256
  );
  assert.equal(evidence.artifact.requiredNodeSqlitePersonality, true);
  assert.equal(evidence.moduleSurfaces.commonjs, true);
  assert.equal(evidence.moduleSurfaces.esmNamedExport, true);
  assert.equal(evidence.runtime.edge, edgeContract.runtime.edgeVersion);
  assert.equal(evidence.runtime.node, edgeContract.runtime.nodeVersion);
  assert.equal(evidence.runtime.v8, edgeContract.runtime.v8Version);
  assert.equal(evidence.sqlite.version, "3.53.0");
  assert.equal(evidence.sqlite.journalMode, "wal");
  assert.equal(evidence.sqlite.lockingMode, "exclusive");
  assert.equal(evidence.sqlite.userVersion, 1);
  assert.equal(evidence.sqlite.tables, sqliteContract.stateSchema.tables);
  assert.equal(evidence.sqlite.explicitIndexes, sqliteContract.stateSchema.indexes);
  assert.equal(evidence.capability.deniedPathEscape, true);
  assert.equal(evidence.persistence.sqliteHeader, "SQLite format 3\u0000");
  assert.ok(evidence.persistence.bytes > 0);
}
