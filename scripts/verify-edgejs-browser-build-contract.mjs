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
const openclawPackage = readJson(
  path.join(repositoryRoot, "contracts/openclaw-package.generated.json")
);
const packageLock = readJson(path.join(repositoryRoot, "package-lock.json"));
const nestedWasmManifest = readFileSync(
  path.join(repositoryRoot, "nested-wasm/Cargo.toml"),
  "utf8"
);
const nestedWasmLock = readFileSync(
  path.join(repositoryRoot, "nested-wasm/Cargo.lock"),
  "utf8"
);

assert.equal(contract.schemaVersion, 21);
assert.equal(contract.runtimeProvider, "quickjs");
assert.equal(contract.upstream.commit, edgeArtifact.source.commit);
assert.equal(contract.upstream.repository, edgeArtifact.source.repository);
assert.deepEqual(contract.reproducibleBuild, {
  sourceDateEpoch: 1_784_765_943,
  sourceDateEpochBasis: "edge-source-commit-time",
  wasmBindgenDeterminismFix: "wasm-bindgen#4892",
  browserExecutorVerification: "repeat-build-and-every-file-sha256",
  distributionArchive: {
    directoryEntries: "omitted",
    entryOrder: "bytewise-path-sort",
    extraFields: "stripped",
    timestamps: "source-date-epoch"
  }
});
assert.equal(contract.toolchain.emitExceptionReferences, false);
assert.equal(contract.toolchain.wasixccWasmExceptions, "legacy");
assert.equal(contract.toolchain.wasixccRunWasmOpt, false);
assert.equal(contract.toolchain.quickjsWebAssembly, true);
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
assert.deepEqual(contract.nodeCompatibility, {
  profile: "openclaw-2026.7",
  reportedVersion: "24.15.0",
  sourceBaselineVersion: "v24.13.2-pre",
  officialNodeBinary: false,
  scope: "unmodified-openclaw-gateway-agent-path",
  openclawFloor: {
    repository: "https://github.com/openclaw/openclaw",
    commit: "f33ab243cf820e7558562381dbfaa1407bfb39a7",
    reason: "sqlite-wal-reset-safety",
    minimumSqlite: "3.51.3",
    safeBackports: ["3.44.6", "3.50.7"]
  },
  requiredProofs: [
    "runtime-source-baseline-and-compat-version",
    "sqlite-wal-cross-process",
    "unmodified-package-integrity",
    "gateway-health-rpc",
    "agent-turn"
  ]
});
assert.equal(
  contract.nodeCompatibility.reportedVersion,
  contract.expectedRuntime.node
);
assert.equal(
  openclawPackage.artifact.nodeEngine,
  ">=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0"
);
assert.match(
  openclawPackage.artifact.nodeEngine,
  new RegExp(`>=${contract.nodeCompatibility.reportedVersion.replaceAll(".", "\\.")}`)
);
assert.deepEqual(contract.nestedWebAssembly, {
  implementation: "wasmi",
  package: "wasmi_c_api_impl",
  version: "0.40.0",
  crateChecksum:
    "45e45f29eb7b0a2c0789c3c8075fc9c2c05182d6be2222702c6c848f72a2c2df",
  license: "MIT OR Apache-2.0",
  rustTarget: "wasm32-unknown-unknown",
  rustTargetFeatures: [
    "atomics",
    "bulk-memory",
    "mutable-globals"
  ],
  archive: "nested-wasm/dist/lib/libwasmer.a",
  capabilities: "none-without-explicit-javascript-imports"
});
assert.match(
  nestedWasmManifest,
  /package = "wasmi_c_api_impl", version = "=0\.40\.0"/u
);
assert.match(
  nestedWasmLock,
  /name = "wasmi_c_api_impl"\nversion = "0\.40\.0"\nsource = "[^"]+"\nchecksum = "45e45f29eb7b0a2c0789c3c8075fc9c2c05182d6be2222702c6c848f72a2c2df"/u
);

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
    { package: "virtual-net", version: "0.601.0" },
    { package: "virtual-net", version: "0.601.0" },
    { package: "wasm-bindgen-futures", version: "0.4.57" },
    { package: "wasm-bindgen-futures", version: "0.4.57" }
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
  successfulSpawnedThreadCleanup: "skip-process-wide-instance-group-shutdown",
  nonzeroSpawnedThreadExit: "process-terminating"
});
assert.deepEqual(contract.browserExecutor.multithreadWaker, {
  wasmBindgen: "0.2.107",
  wasmBindgenFutures: "0.4.57",
  waitAsyncPromiseCallback: "wake-before-run",
  upstreamFix: "wasm-bindgen#4821",
  maxSleepMs: 1000,
  lostWakeRecovery: "bounded-wait-async-repoll",
  waitImplementation: "native-atomics-wait-async-only",
  synchronousWaitFallback: "excluded"
});
assert.deepEqual(contract.browserExecutor.build, {
  rustToolchain: "nightly-2025-07-05",
  wasmBindgenVersion: "0.2.107",
  wasmBindgenLinuxAsset:
    "wasm-bindgen-0.2.107-x86_64-unknown-linux-musl.tar.gz",
  wasmBindgenLinuxSha256:
    "ca225ef4f1c6b64b8c6aee460d21b1087342edb71a715e83f05949598c237685",
  binaryenVersion: "version_117",
  binaryenLinuxAsset: "binaryen-version_117-x86_64-linux.tar.gz",
  binaryenLinuxSha256:
    "3dc677006555b355ea2da5e82602065a161d5e83eaefd3f759afa00b96e83212",
  binaryenOptimizationPasses: [
    "--enable-threads --enable-bulk-memory -Oz",
    "-O2"
  ]
});
assert.deepEqual(contract.browserExecutor.networkCapability, {
  default: "deny",
  loopback: {
    scope: "runtime-object",
    transport: "browser-local",
    tcpReceiveLifecycle: {
      partialReads: "rearm-readable-while-buffered",
      partialWrites: "notify-readable-after-enqueue",
      readWriteWakers: "direction-separated",
      writeReadiness: "level-triggered-until-buffer-full"
    }
  },
  egress: {
    transport: "virtual-net-over-websocket",
    relayImplementation: "relay/",
    relayLicense: "MIT",
    credentialTransport: "Sec-WebSocket-Protocol",
    authority: "dns-derived-ip-and-port",
    rawIp: "deny",
    privateNetwork: "deny-unless-explicit",
    tcpReceiveLifecycle: {
      closedInterest: "drain-and-forward-eof",
      eofFrame: "empty-receive-returned-as-zero-length-read",
      queuedFrames: "rearm-readable-until-drained"
    },
    exposes: ["dns-resolution", "outbound-tcp"]
  }
});

assert.equal(
  contract.browserExecutor.schedulerStress.asyncWorkerLifetime,
  "scheduler-lifetime"
);
assert.equal(
  contract.browserExecutor.schedulerStress.asyncWorkerAllocation,
  "lazy-bounded-cooperative-pool"
);
assert.equal(
  contract.browserExecutor.schedulerStress.maxAsyncWorkers,
  8
);
assert.equal(
  contract.browserExecutor.schedulerStress.asyncFutureReservation,
  "none"
);
assert.equal(
  contract.browserExecutor.schedulerStress.asyncConcurrency,
  "concurrent-cooperative-nonblocking-futures-per-worker"
);
assert.equal(
  contract.browserExecutor.schedulerStress.asyncDispatch,
  "acceptance-acknowledged-ready-queue"
);
assert.equal(
  contract.browserExecutor.schedulerStress.asyncBackpressure,
  "queue-until-javascript-handler-invocation-acknowledged"
);
assert.equal(
  contract.browserExecutor.schedulerStress
    .maxUnacknowledgedAsyncMessagesPerWorker,
  1
);
assert.equal(
  contract.browserExecutor.schedulerStress.asyncCompletionDependency,
  "none"
);
assert.equal(
  contract.browserExecutor.schedulerStress.timerWorkerAllocation,
  "one-dedicated-timer-worker-per-scheduler"
);
assert.equal(
  contract.browserExecutor.schedulerStress.timerConcurrency,
  "concurrent-timer-futures"
);
assert.equal(
  contract.browserExecutor.schedulerStress.blockingWorkerRelease,
  "after-javascript-handler-completion"
);
assert.equal(
  contract.browserExecutor.schedulerStress.sleepTimerReservation,
  "until-javascript-timer-resolution"
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
  nested_wasm_crate_checksum: contract.nestedWebAssembly.crateChecksum,
  nested_wasm_rust_target: contract.nestedWebAssembly.rustTarget,
  nested_wasm_target_features:
    contract.nestedWebAssembly.rustTargetFeatures
      .map((feature) => `+${feature}`)
      .join(","),
  nested_wasm_version: contract.nestedWebAssembly.version,
  quickjs_webassembly: contract.toolchain.quickjsWebAssembly ? "yes" : "no",
  runtime_provider: contract.runtimeProvider,
  source_date_epoch: String(contract.reproducibleBuild.sourceDateEpoch),
  rust_version: contract.toolchain.rustVersion,
  sysroot_asset: contract.toolchain.sysrootAsset,
  sysroot_asset_sha256: contract.toolchain.sysrootAssetSha256,
  sysroot_tag: contract.toolchain.sysrootTag,
  wasmer_rust_toolchain: contract.browserExecutor.build.rustToolchain,
  wasmer_source_commit: contract.browserExecutor.upstream.commit,
  wasmer_source_repository: contract.browserExecutor.upstream.repository,
  wasm_bindgen_linux_asset:
    contract.browserExecutor.build.wasmBindgenLinuxAsset,
  wasm_bindgen_linux_sha256:
    contract.browserExecutor.build.wasmBindgenLinuxSha256,
  wasm_bindgen_version: contract.browserExecutor.build.wasmBindgenVersion,
  binaryen_linux_asset: contract.browserExecutor.build.binaryenLinuxAsset,
  binaryen_linux_sha256:
    contract.browserExecutor.build.binaryenLinuxSha256,
  binaryen_version: contract.browserExecutor.build.binaryenVersion,
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
