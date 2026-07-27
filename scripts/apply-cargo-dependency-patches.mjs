import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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

  const commonArguments = [
    "--force",
    "--silent",
    "--directory",
    dependencySource,
    "--strip",
    "1"
  ];
  if (patchSucceeds([...commonArguments, "--dry-run"], patchBytes)) {
    const applied = spawnSync("patch", commonArguments, {
      input: patchBytes,
      stdio: ["pipe", "inherit", "inherit"]
    });
    assert.equal(
      applied.status,
      0,
      `Failed to apply ${dependencyPatch.path}`
    );
    console.log(
      `Applied ${dependencyPatch.path} to `
        + `${dependencyPatch.package}@${dependencyPatch.version}`
    );
    continue;
  }
  if (
    patchSucceeds(
      [...commonArguments, "--reverse", "--dry-run"],
      patchBytes
    )
  ) {
    console.log(
      `Already applied ${dependencyPatch.path} to `
        + `${dependencyPatch.package}@${dependencyPatch.version}`
    );
    continue;
  }
  throw new Error(
    `${dependencyPatch.path} applies neither forward nor in reverse to `
      + `${dependencyPatch.package}@${dependencyPatch.version}`
  );
}

function patchSucceeds(arguments_, input) {
  return spawnSync("patch", arguments_, {
    input,
    stdio: ["pipe", "ignore", "ignore"]
  }).status === 0;
}
