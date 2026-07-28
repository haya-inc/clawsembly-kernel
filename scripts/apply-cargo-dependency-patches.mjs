import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({
  options: {
    contract: { type: "string" },
    manifest: { type: "string", default: "Cargo.toml" },
    package: { type: "string", multiple: true },
    target: { type: "string" }
  },
  strict: true
});
const contractPath = values.contract
  ? path.resolve(values.contract)
  : path.join(repositoryRoot, "contracts/edgejs-browser-build.json");
const manifestPath = path.resolve(values.manifest);
const contract = JSON.parse(readFileSync(contractPath, "utf8"));
const selectedPackages = new Set(values.package ?? []);
const patches = contract.browserExecutor.dependencyPatches.filter(
  ({ package: packageName }) =>
    selectedPackages.size === 0 || selectedPackages.has(packageName)
);

assert.ok(patches.length > 0, "No Cargo dependency patches were selected");
for (const packageName of selectedPackages) {
  assert.ok(
    patches.some((patch) => patch.package === packageName),
    `No dependency patch is contracted for ${packageName}`
  );
}

const metadataArguments = [
  "metadata",
  "--locked",
  "--format-version",
  "1",
  "--manifest-path",
  manifestPath
];
if (values.target) {
  metadataArguments.push("--filter-platform", values.target);
}
const metadataResult = spawnSync(
  process.env.CARGO ?? "cargo",
  metadataArguments,
  {
    cwd: path.dirname(manifestPath),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"]
  }
);
if (metadataResult.error) throw metadataResult.error;
assert.equal(
  metadataResult.status,
  0,
  `cargo metadata failed for ${manifestPath}`
);
const metadata = JSON.parse(metadataResult.stdout);
const patchGroups = new Map();

for (const dependencyPatch of patches) {
  const matches = metadata.packages.filter(
    (candidate) =>
      candidate.name === dependencyPatch.package
      && candidate.version === dependencyPatch.version
  );
  assert.equal(
    matches.length,
    1,
    `Expected exactly one ${dependencyPatch.package}@${dependencyPatch.version} `
      + `in ${manifestPath}, found ${matches.length}`
  );
  const dependencySource = path.dirname(matches[0].manifest_path);
  const patchPath = path.join(repositoryRoot, dependencyPatch.path);
  const patchBytes = readFileSync(patchPath);
  const actualSha256 = createHash("sha256").update(patchBytes).digest("hex");
  assert.equal(
    actualSha256,
    dependencyPatch.sha256,
    `Cargo dependency patch integrity mismatch: ${dependencyPatch.path}`
  );

  const groupKey =
    `${dependencyPatch.package}@${dependencyPatch.version}:${dependencySource}`;
  const group = patchGroups.get(groupKey) ?? {
    dependencySource,
    packageName: dependencyPatch.package,
    patches: [],
    version: dependencyPatch.version
  };
  group.patches.push({
    bytes: patchBytes,
    path: dependencyPatch.path
  });
  patchGroups.set(groupKey, group);
}

for (const group of patchGroups.values()) {
  const appliedPrefix = detectAppliedPrefix(
    group.dependencySource,
    group.patches
  );
  if (appliedPrefix < 0) {
    throw new Error(
      `${group.patches.map((patch) => patch.path).join(", ")} apply neither `
        + `as an ordered forward series nor as an already-applied prefix to `
        + `${group.packageName}@${group.version}`
    );
  }

  for (const dependencyPatch of group.patches.slice(0, appliedPrefix)) {
    console.log(
      `Already applied ${dependencyPatch.path} to `
        + `${group.packageName}@${group.version}`
    );
  }

  for (const dependencyPatch of group.patches.slice(appliedPrefix)) {
    const applied = applyPatch(
      group.dependencySource,
      dependencyPatch.bytes,
      false,
      ["pipe", "inherit", "inherit"]
    );
    assert.equal(
      applied,
      true,
      `Failed to apply ${dependencyPatch.path}`
    );
    console.log(
      `Applied ${dependencyPatch.path} to `
        + `${group.packageName}@${group.version}`
    );
  }
}

/**
 * Identify a valid state where the first N patches in an ordered series are
 * already present and the remaining patches are not. Later patches may edit
 * lines introduced by earlier ones, so checking every patch independently in
 * reverse is not sufficient.
 */
function detectAppliedPrefix(dependencySource, dependencyPatches) {
  for (
    let appliedPrefix = 0;
    appliedPrefix <= dependencyPatches.length;
    appliedPrefix += 1
  ) {
    const temporaryRoot = mkdtempSync(
      path.join(tmpdir(), "clawsembly-cargo-patches-")
    );
    const temporarySource = path.join(temporaryRoot, "source");
    try {
      cpSync(dependencySource, temporarySource, { recursive: true });
      let valid = true;
      for (
        let index = appliedPrefix - 1;
        index >= 0 && valid;
        index -= 1
      ) {
        valid = applyPatch(
          temporarySource,
          dependencyPatches[index].bytes,
          true
        );
      }
      for (
        let index = 0;
        index < dependencyPatches.length && valid;
        index += 1
      ) {
        valid = applyPatch(
          temporarySource,
          dependencyPatches[index].bytes
        );
      }
      if (valid) return appliedPrefix;
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true });
    }
  }
  return -1;
}

function applyPatch(
  dependencySource,
  patchBytes,
  reverse = false,
  stdio = ["pipe", "ignore", "ignore"]
) {
  const arguments_ = [
    "--force",
    "--silent",
    "--directory",
    dependencySource,
    "--strip",
    "1"
  ];
  if (reverse) arguments_.push("--reverse");
  return spawnSync("patch", arguments_, {
    input: patchBytes,
    stdio
  }).status === 0;
}
