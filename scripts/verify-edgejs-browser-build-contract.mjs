import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  readFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const contract = readJson(
  path.join(repositoryRoot, "contracts/edgejs-browser-build.json")
);
const edgeArtifact = readJson(
  path.join(repositoryRoot, "contracts/edgejs-artifact.json")
);
const packageLock = readJson(path.join(repositoryRoot, "package-lock.json"));

assert.equal(contract.schemaVersion, 1);
assert.equal(contract.upstream.commit, edgeArtifact.source.commit);
assert.equal(contract.upstream.repository, edgeArtifact.source.repository);
assert.equal(contract.toolchain.emitExceptionReferences, false);
assert.equal(contract.toolchain.wasixccWasmExceptions, "legacy");

for (const patch of contract.patches) {
  const patchPath = path.join(repositoryRoot, patch.path);
  const actualSha256 = createHash("sha256")
    .update(readFileSync(patchPath))
    .digest("hex");
  assert.equal(
    actualSha256,
    patch.sha256,
    `Edge.js patch integrity mismatch: ${patch.path}`
  );
}

const sdk = packageLock.packages?.["node_modules/@wasmer/sdk"];
assert.ok(sdk, "package-lock.json has no @wasmer/sdk entry");
assert.equal(sdk.version, contract.browserExecutor.version);
assert.equal(sdk.integrity, contract.browserExecutor.integrity);

const outputs = {
  edge_source_commit: contract.upstream.commit,
  edge_source_repository: contract.upstream.repository,
  emit_exnref: contract.toolchain.emitExceptionReferences ? "yes" : "no",
  patch_path: contract.patches[0].path,
  rust_version: contract.toolchain.rustVersion,
  sysroot_tag: contract.toolchain.sysrootTag,
  wasm_tools_version: contract.toolchain.wasmToolsVersion,
  wasixcc_version: contract.toolchain.wasixccVersion,
  wasixcc_wasm_exceptions: contract.toolchain.wasixccWasmExceptions
};

if (process.argv.includes("--github-output")) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) throw new Error("GITHUB_OUTPUT is required");
  appendFileSync(
    outputPath,
    Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join("")
  );
}

console.log(
  `Verified Edge.js browser build contract at ${contract.upstream.commit}: `
  + `${contract.patches.length} patch, @wasmer/sdk@${sdk.version}, `
  + `wasm-exceptions=${outputs.wasixcc_wasm_exceptions}, `
  + `emit-exnref=${outputs.emit_exnref}.`
);

function readJson(filename) {
  return JSON.parse(readFileSync(filename, "utf8"));
}
