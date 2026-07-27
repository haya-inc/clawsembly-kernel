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

assert.equal(contract.schemaVersion, 7);
assert.equal(contract.runtimeProvider, "quickjs");
assert.equal(contract.upstream.commit, edgeArtifact.source.commit);
assert.equal(contract.upstream.repository, edgeArtifact.source.repository);
assert.equal(contract.toolchain.emitExceptionReferences, false);
assert.equal(contract.toolchain.wasixccWasmExceptions, "legacy");
assert.equal(contract.toolchain.wasixccRunWasmOpt, false);
assert.equal(contract.toolchain.quickjsWebAssembly, false);
assert.equal(contract.toolchain.sysrootAsset, "sysroot-eh.tar.gz");
assert.match(contract.toolchain.sysrootAssetSha256, /^[0-9a-f]{64}$/u);
assert.equal(contract.sqlite.version, "3.53.4");
assert.equal(contract.sqlite.amalgamationCode, 3530400);
assert.equal(
  contract.sqlite.url,
  `https://www.sqlite.org/2026/${contract.sqlite.archive}`
);
assert.equal(contract.sqlite.bytes, 2_946_650);
assert.match(contract.sqlite.sha256, /^[0-9a-f]{64}$/u);
assert.match(contract.sqlite.sha3_256, /^[0-9a-f]{64}$/u);
assert.deepEqual(
  contract.sqlite.sourceFiles,
  ["sqlite3.c", "sqlite3.h", "sqlite3ext.h"]
);
assert.equal(contract.sqlite.extensionLoading, false);

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

for (const patch of contract.browserExecutor.patches) {
  const patchPath = path.join(repositoryRoot, patch.path);
  const actualSha256 = createHash("sha256")
    .update(readFileSync(patchPath))
    .digest("hex");
  assert.equal(
    actualSha256,
    patch.sha256,
    `Wasmer JS patch integrity mismatch: ${patch.path}`
  );
}

assert.deepEqual(
  contract.browserExecutor.dependencyPatches.map(
    ({ package: packageName, version }) => ({ package: packageName, version })
  ),
  [
    { package: "wasmer-wasix", version: "0.601.0" },
    { package: "virtual-net", version: "0.601.0" }
  ]
);
for (const patch of contract.browserExecutor.dependencyPatches) {
  const patchPath = path.join(repositoryRoot, patch.path);
  const actualSha256 = createHash("sha256")
    .update(readFileSync(patchPath))
    .digest("hex");
  assert.equal(
    actualSha256,
    patch.sha256,
    `Cargo dependency patch integrity mismatch: ${patch.path}`
  );
}
assert.deepEqual(contract.browserExecutor.threadExitPolicy, {
  successfulSpawnedThreadExit: "thread-local",
  nonzeroSpawnedThreadExit: "process-terminating"
});
assert.deepEqual(contract.browserExecutor.networkCapability, {
  default: "deny",
  loopback: {
    scope: "runtime-object",
    transport: "browser-local"
  },
  egress: {
    transport: "virtual-net-over-websocket",
    relayImplementation: "relay/",
    relayLicense: "MIT",
    credentialTransport: "Sec-WebSocket-Protocol",
    authority: "dns-derived-ip-and-port",
    rawIp: "deny",
    privateNetwork: "deny-unless-explicit",
    exposes: ["dns-resolution", "outbound-tcp"]
  }
});

assert.equal(
  contract.browserExecutor.schedulerStress.asyncWorkerReservation,
  "until-future-completion"
);
assert.equal(
  contract.browserExecutor.schedulerStress.browserCpuThrottlingRate,
  12
);

const sdk = packageLock.packages?.["node_modules/@wasmer/sdk"];
assert.ok(sdk, "package-lock.json has no @wasmer/sdk entry");
assert.equal(sdk.version, contract.browserExecutor.version);

const outputs = {
  edge_source_commit: contract.upstream.commit,
  edge_source_repository: contract.upstream.repository,
  emit_exnref: contract.toolchain.emitExceptionReferences ? "yes" : "no",
  quickjs_webassembly: contract.toolchain.quickjsWebAssembly ? "yes" : "no",
  runtime_provider: contract.runtimeProvider,
  rust_version: contract.toolchain.rustVersion,
  sysroot_asset: contract.toolchain.sysrootAsset,
  sysroot_asset_sha256: contract.toolchain.sysrootAssetSha256,
  sysroot_tag: contract.toolchain.sysrootTag,
  wasmer_rust_toolchain: contract.browserExecutor.build.rustToolchain,
  wasmer_source_commit: contract.browserExecutor.upstream.commit,
  wasmer_source_repository: contract.browserExecutor.upstream.repository,
  wasm_pack_linux_asset: contract.browserExecutor.build.wasmPackLinuxAsset,
  wasm_pack_linux_sha256: contract.browserExecutor.build.wasmPackLinuxSha256,
  wasm_pack_version: contract.browserExecutor.build.wasmPackVersion,
  wasm_tools_version: contract.toolchain.wasmToolsVersion,
  sqlite_archive: contract.sqlite.archive,
  sqlite_bytes: String(contract.sqlite.bytes),
  sqlite_sha256: contract.sqlite.sha256,
  sqlite_sha3_256: contract.sqlite.sha3_256,
  sqlite_url: contract.sqlite.url,
  sqlite_version: contract.sqlite.version,
  wasixcc_version: contract.toolchain.wasixccVersion,
  wasixcc_wasm_exceptions: contract.toolchain.wasixccWasmExceptions,
  wasixcc_run_wasm_opt: contract.toolchain.wasixccRunWasmOpt ? "yes" : "no"
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
  + `${contract.runtimeProvider} provider, ${contract.patches.length} Edge.js patches, `
  + `SQLite ${contract.sqlite.version}, `
  + `self-built @wasmer/sdk@${sdk.version} from `
  + `${contract.browserExecutor.upstream.commit}, `
  + `${contract.browserExecutor.patches.length} Wasmer JS patches, `
  + `${contract.browserExecutor.dependencyPatches.length} Cargo dependency patches, `
  + `${contract.browserExecutor.schedulerStress.browserCpuThrottlingRate}x `
  + "browser CPU stress, "
  + `quickjs-webassembly=${outputs.quickjs_webassembly}, `
  + `wasm-exceptions=${outputs.wasixcc_wasm_exceptions}, `
  + `wasixcc-wasm-opt=${outputs.wasixcc_run_wasm_opt}, `
  + `emit-exnref=${outputs.emit_exnref}.`
);

function readJson(filename) {
  return JSON.parse(readFileSync(filename, "utf8"));
}
