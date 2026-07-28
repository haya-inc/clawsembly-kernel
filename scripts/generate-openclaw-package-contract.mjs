import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactContractPath = path.join(
  root,
  "contracts",
  "openclaw-artifact.json"
);
const packageContractPath = path.join(
  root,
  "contracts",
  "openclaw-package.generated.json"
);
const check = process.argv.includes("--check");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sortedKeys(value) {
  return Object.keys(value ?? {}).sort();
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function extractTarEntry(archivePath, entry) {
  const result = spawnSync("tar", ["-xOf", archivePath, entry], {
    encoding: null,
    maxBuffer: 32 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(
      `could not extract ${entry}: ${result.stderr?.toString("utf8") ?? ""}`
    );
  }
  return result.stdout;
}

function validateInstallPath(installPath) {
  if (
    !installPath.startsWith("node_modules/")
    || path.posix.normalize(installPath) !== installPath
    || installPath.split("/").includes("..")
  ) {
    throw new Error(`unsafe shrinkwrap install path: ${installPath}`);
  }
}

function validateResolvedUrl(resolved, installPath) {
  const url = new URL(resolved);
  if (url.protocol !== "https:") {
    throw new Error(`${installPath} has a non-HTTPS resolved URL`);
  }
}

function validateIntegrity(integrity, installPath) {
  const tokens = integrity.trim().split(/\s+/u);
  if (
    tokens.length === 0
    || tokens.some((token) => !/^(?:sha256|sha384|sha512)-[A-Za-z0-9+/]+={0,2}$/u.test(token))
  ) {
    throw new Error(`${installPath} has an unsupported SRI value`);
  }
}

function optionalArray(value, label) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return [...value];
}

function packageEntry(installPath, value) {
  validateInstallPath(installPath);
  const version = assertString(value.version, `${installPath}.version`);
  const resolved = assertString(value.resolved, `${installPath}.resolved`);
  const integrity = assertString(value.integrity, `${installPath}.integrity`);
  validateResolvedUrl(resolved, installPath);
  validateIntegrity(integrity, installPath);

  return {
    installPath,
    version,
    resolved,
    integrity,
    ...(value.optional === true ? { optional: true } : {}),
    ...(value.hasInstallScript === true ? { hasInstallScript: true } : {}),
    ...(value.cpu === undefined
      ? {}
      : { cpu: optionalArray(value.cpu, `${installPath}.cpu`) }),
    ...(value.os === undefined
      ? {}
      : { os: optionalArray(value.os, `${installPath}.os`) }),
    ...(value.libc === undefined
      ? {}
      : { libc: optionalArray(value.libc, `${installPath}.libc`) })
  };
}

function sameStringMap(left, right) {
  const leftKeys = sortedKeys(left);
  const rightKeys = sortedKeys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => (
      key === rightKeys[index] && left[key] === right[key]
    ));
}

async function readOfficialArchive(artifact) {
  const override = process.env.CLAWSEMBLY_OPENCLAW_ARCHIVE;
  if (override) return readFile(path.resolve(override));

  const response = await fetch(artifact.tarball);
  if (!response.ok) {
    throw new Error(`artifact download failed with HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function assertOrWrite(target, expected) {
  if (check) {
    let actual;
    try {
      actual = await readFile(target, "utf8");
    } catch {
      throw new Error(
        `${path.relative(root, target)} is missing; run npm run package-contract:generate`
      );
    }
    if (actual !== expected) {
      throw new Error(
        `${path.relative(root, target)} is stale; run npm run package-contract:generate`
      );
    }
    return;
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, expected);
}

async function main() {
  const artifact = JSON.parse(await readFile(artifactContractPath, "utf8"));
  const archive = await readOfficialArchive(artifact);
  const actualIntegrity =
    `sha512-${createHash("sha512").update(archive).digest("base64")}`;
  if (actualIntegrity !== artifact.integrity) {
    throw new Error(
      `artifact integrity mismatch: expected ${artifact.integrity}, got ${actualIntegrity}`
    );
  }

  const temporaryArchive = path.join(
    process.env.TMPDIR ?? "/tmp",
    `clawsembly-openclaw-package-contract-${process.pid}.tgz`
  );
  await writeFile(temporaryArchive, archive, { mode: 0o600 });
  try {
    const packageJsonBytes = extractTarEntry(
      temporaryArchive,
      "package/package.json"
    );
    const shrinkwrapBytes = extractTarEntry(
      temporaryArchive,
      "package/npm-shrinkwrap.json"
    );
    const launcherBytes = extractTarEntry(
      temporaryArchive,
      "package/openclaw.mjs"
    );
    const entryBytes = extractTarEntry(
      temporaryArchive,
      "package/dist/entry.js"
    );
    const packageJson = JSON.parse(packageJsonBytes.toString("utf8"));
    const shrinkwrap = JSON.parse(shrinkwrapBytes.toString("utf8"));

    if (
      packageJson.name !== artifact.name
      || packageJson.version !== artifact.version
    ) {
      throw new Error("official package metadata does not match the artifact contract");
    }
    if (shrinkwrap.lockfileVersion !== 3) {
      throw new Error(
        `unsupported npm shrinkwrap version: ${shrinkwrap.lockfileVersion}`
      );
    }
    const rootEntry = shrinkwrap.packages?.[""];
    if (!rootEntry) throw new Error("npm shrinkwrap has no root package entry");
    if (
      rootEntry.name !== artifact.name
      || rootEntry.version !== artifact.version
    ) {
      throw new Error("npm shrinkwrap root does not match the artifact contract");
    }
    if (!sameStringMap(rootEntry.dependencies, packageJson.dependencies)) {
      throw new Error(
        "npm shrinkwrap runtime dependencies do not match package.json"
      );
    }
    if (
      !sameStringMap(
        rootEntry.optionalDependencies,
        packageJson.optionalDependencies
      )
    ) {
      throw new Error(
        "npm shrinkwrap optional dependencies do not match package.json"
      );
    }

    const dependencies = Object.entries(shrinkwrap.packages)
      .filter(([installPath]) => installPath !== "")
      .map(([installPath, value]) => packageEntry(installPath, value))
      .sort((left, right) => compareStrings(
        left.installPath,
        right.installPath
      ));
    const lifecycleEntries = [
      ...(rootEntry.hasInstallScript === true
        ? [{ installPath: "", version: rootEntry.version }]
        : []),
      ...dependencies
        .filter((entry) => entry.hasInstallScript === true)
        .map(({ installPath, version }) => ({ installPath, version }))
    ];
    const contract = {
      schemaVersion: 1,
      artifact: {
        name: artifact.name,
        version: artifact.version,
        integrity: artifact.integrity,
        nodeEngine: artifact.nodeEngine
      },
      packageJsonSha256: sha256(packageJsonBytes),
      artifactFiles: {
        launcher: {
          path: "openclaw.mjs",
          bytes: launcherBytes.byteLength,
          sha256: sha256(launcherBytes)
        },
        entry: {
          path: "dist/entry.js",
          bytes: entryBytes.byteLength,
          sha256: sha256(entryBytes)
        }
      },
      shrinkwrap: {
        lockfileVersion: shrinkwrap.lockfileVersion,
        sha256: sha256(shrinkwrapBytes),
        rootRuntimeDependencies: sortedKeys(packageJson.dependencies).length,
        rootOptionalDependencies:
          sortedKeys(packageJson.optionalDependencies).length,
        excludedRootDevDependencies:
          sortedKeys(packageJson.devDependencies).length,
        dependencyArchives: dependencies.length,
        lifecycleEntries
      },
      dependencies
    };

    await assertOrWrite(
      packageContractPath,
      `${JSON.stringify(contract, null, 2)}\n`
    );
    process.stdout.write(
      `${check ? "Verified" : "Generated"} OpenClaw package contract for `
      + `${artifact.name}@${artifact.version}: ${dependencies.length} `
      + `integrity-pinned runtime archives, ${lifecycleEntries.length} `
      + "lifecycle-script entries.\n"
    );
  } finally {
    const { rm } = await import("node:fs/promises");
    await rm(temporaryArchive, { force: true });
  }
}

await main();
