import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const contract = readJson(
  path.join(repositoryRoot, "contracts/edgejs-browser-build.json")
);
const manifestArgument = process.argv[2];

if (!manifestArgument) {
  throw new Error(
    "Usage: node scripts/apply-wasmer-cargo-dependency-patches.mjs "
    + "<wasmer-js/Cargo.toml>"
  );
}

const manifestPath = path.resolve(manifestArgument);
const lockPath = path.join(path.dirname(manifestPath), "Cargo.lock");
const lockPackages = parseLockPackages(readFileSync(lockPath, "utf8"));
const metadata = JSON.parse(
  execFileSync(
    "cargo",
    [
      "metadata",
      "--locked",
      "--format-version",
      "1",
      "--manifest-path",
      manifestPath
    ],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024
    }
  )
);

for (const dependency of contract.browserExecutor.dependencyPatches) {
  const lockPackage = lockPackages.find((candidate) =>
    candidate.name === dependency.package
    && candidate.version === dependency.version
  );
  assert.ok(
    lockPackage,
    `Cargo.lock has no ${dependency.package}@${dependency.version}`
  );
  assert.equal(
    lockPackage.source,
    dependency.source,
    `${dependency.package} Cargo source mismatch`
  );
  assert.equal(
    lockPackage.checksum,
    dependency.crateSha256,
    `${dependency.package} crate checksum mismatch`
  );

  const metadataPackage = metadata.packages.find((candidate) =>
    candidate.name === dependency.package
    && candidate.version === dependency.version
  );
  assert.ok(
    metadataPackage,
    `cargo metadata has no ${dependency.package}@${dependency.version}`
  );
  assert.equal(
    metadataPackage.source,
    dependency.source,
    `${dependency.package} resolved source mismatch`
  );

  const packageRoot = path.dirname(metadataPackage.manifest_path);
  const patchPath = path.join(repositoryRoot, dependency.patch.path);
  const patchApplies = gitApplyCheck(packageRoot, patchPath, []);
  if (patchApplies) {
    execFileSync("git", ["apply", patchPath], {
      cwd: packageRoot,
      stdio: "inherit"
    });
  } else {
    assert.ok(
      gitApplyCheck(packageRoot, patchPath, ["--reverse"]),
      `${dependency.patch.path} applies neither forward nor in reverse`
    );
  }

  const verificationPath = path.join(
    packageRoot,
    dependency.verification.targetFile
  );
  const source = readFileSync(verificationPath, "utf8");
  const functionStart = source.indexOf(dependency.verification.function);
  assert.notEqual(
    functionStart,
    -1,
    `Missing ${dependency.verification.function} in ${verificationPath}`
  );
  const functionEnd = source.indexOf("\n    }\n", functionStart);
  assert.notEqual(
    functionEnd,
    -1,
    `Could not delimit ${dependency.verification.function}`
  );
  const functionBody = source.slice(functionStart, functionEnd);
  assert.ok(
    functionBody.includes(dependency.verification.expectedSnippet),
    `${dependency.verification.function} does not contain `
    + dependency.verification.expectedSnippet
  );

  console.log(
    `${patchApplies ? "Applied" : "Verified"} `
    + `${dependency.patch.path} against `
    + `${dependency.package}@${dependency.version} `
    + `(${dependency.crateSha256}).`
  );
}

function gitApplyCheck(cwd, patchPath, extraArguments) {
  try {
    execFileSync(
      "git",
      ["apply", ...extraArguments, "--check", patchPath],
      { cwd, stdio: "pipe" }
    );
    return true;
  } catch {
    return false;
  }
}

function parseLockPackages(lockSource) {
  return lockSource
    .split(/\n(?=\[\[package\]\]\n)/u)
    .filter((block) => block.startsWith("[[package]]\n"))
    .map((block) => ({
      checksum: tomlString(block, "checksum"),
      name: tomlString(block, "name"),
      source: tomlString(block, "source"),
      version: tomlString(block, "version")
    }));
}

function tomlString(block, key) {
  const match = block.match(new RegExp(`^${key} = "([^"]+)"$`, "mu"));
  return match?.[1];
}

function readJson(filename) {
  return JSON.parse(readFileSync(filename, "utf8"));
}
