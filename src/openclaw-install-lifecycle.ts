import type {
  Directory,
  Runtime,
  runWasix as wasmerRunWasix
} from "@wasmer/sdk";

type WasixOutput = {
  code: number;
  ok: boolean;
  stderr: string;
  stdout: string;
};

type RunWasix = typeof wasmerRunWasix;
type WasixModule = Parameters<RunWasix>[0];

type LifecycleExecution = {
  command: string;
  cwd: string;
  name: "preinstall" | "postinstall";
  package: string;
  result: WasixOutput;
  version: string;
};

export type OpenClawInstallLifecycleEvidence = {
  executor: "@wasmer/sdk shared Directory + Edge.js QuickJS/WASIX";
  packageFiles: {
    mutated: false;
    verification:
      "clean-image postinstall completed without a prune or runtime hotfix";
  };
  requiredEffects: {
    executions: LifecycleExecution[];
    packageStateDatabase: {
      bytes: number;
      hostContractVersion: string;
      indexedPlugins: number;
      migrationVersion: number;
      path: string;
      refreshReason: string;
    };
  };
  reviewedNonEffects: Array<{
    command: string;
    disposition: string;
    name: "preinstall" | "install";
    package: string;
    reason: string;
    version: string;
  }>;
  schemaVersion: 1;
  status: "pass";
};

async function runNodeLifecycleScript(options: {
  command: string;
  cwd: string;
  directory: Directory;
  homeDir: string;
  module: WasixModule;
  name: LifecycleExecution["name"];
  package: string;
  runWasix: RunWasix;
  runtime?: Runtime;
  scriptPath: string;
  stateDir: string;
  version: string;
}): Promise<LifecycleExecution> {
  const instance = await options.runWasix(options.module, {
    program: "edgejs",
    args: [options.scriptPath],
    cwd: options.cwd,
    env: {
      FORCE_COLOR: "0",
      HOME: options.homeDir,
      NO_COLOR: "1",
      OPENCLAW_HOME: options.homeDir,
      OPENCLAW_STATE_DIR: options.stateDir,
      PATH: "/bin",
      npm_config_user_agent:
        "pnpm/11.2.2 clawsembly-browser-kernel"
    },
    mount: {
      "/openclaw": options.directory
    },
    ...(options.runtime === undefined
      ? {}
      : { runtime: options.runtime })
  });
  const rawResult = await instance.wait();
  const result: WasixOutput = {
    code: rawResult.code,
    ok: rawResult.ok,
    stderr: rawResult.stderr,
    stdout: rawResult.stdout
  };
  if (!result.ok) {
    throw new Error(
      `${options.package} ${options.name} failed with ${result.code}: `
      + (result.stderr || result.stdout)
    );
  }
  return {
    command: options.command,
    cwd: options.cwd,
    name: options.name,
    package: options.package,
    result,
    version: options.version
  };
}

export async function runOpenClawInstallLifecycle(options: {
  directory: Directory;
  homeDir: string;
  module: WasixModule;
  runWasix: RunWasix;
  runtime?: Runtime;
  stateDir: string;
}): Promise<OpenClawInstallLifecycleEvidence> {
  const executions: LifecycleExecution[] = [];
  executions.push(await runNodeLifecycleScript({
    ...options,
    command: "node scripts/preinstall-package-manager-warning.mjs",
    cwd: "/openclaw",
    name: "preinstall",
    package: "openclaw",
    scriptPath: "/openclaw/scripts/preinstall-package-manager-warning.mjs",
    version: "2026.7.1-2"
  }));
  executions.push(await runNodeLifecycleScript({
    ...options,
    command: "node scripts/postinstall",
    cwd: "/openclaw/node_modules/protobufjs",
    name: "postinstall",
    package: "protobufjs",
    scriptPath: "/openclaw/node_modules/protobufjs/scripts/postinstall.js",
    version: "7.6.3"
  }));
  executions.push(await runNodeLifecycleScript({
    ...options,
    command: "node scripts/postinstall-bundled-plugins.mjs",
    cwd: "/openclaw",
    name: "postinstall",
    package: "openclaw",
    scriptPath: "/openclaw/scripts/postinstall-bundled-plugins.mjs",
    version: "2026.7.1-2"
  }));

  const rootPostinstall = executions.at(-1);
  if (
    !rootPostinstall
    || !rootPostinstall.result.stdout.includes(
      "[postinstall] migrated plugin registry: 33 plugin(s) indexed"
    )
    || rootPostinstall.result.stdout.includes("pruned ")
    || rootPostinstall.result.stdout.includes("patched baileys")
  ) {
    throw new Error(
      "clean OpenClaw image unexpectedly required a package-file mutation"
    );
  }

  const databasePath = `${options.stateDir}/state/openclaw.sqlite`;
  const mountedDatabasePath = databasePath.replace(/^\/openclaw/u, "");
  const database = await options.directory.readFile(mountedDatabasePath);
  if (database.byteLength < 4_096) {
    throw new Error(
      `OpenClaw postinstall state database is too small: ${database.byteLength}`
    );
  }
  const databaseMarker = "CLAWSEMBLY_LIFECYCLE_DB=";
  const databaseVerificationSource = [
    "const {DatabaseSync}=require('node:sqlite');",
    `const db=new DatabaseSync(${JSON.stringify(databasePath)},`,
    "{readOnly:true});",
    "const row=db.prepare(",
    "'SELECT host_contract_version,migration_version,refresh_reason,'+",
    "'plugins_json FROM installed_plugin_index WHERE index_key=?'",
    ").get('installed-plugin-index');",
    "if(!row)throw new Error('installed plugin index is missing');",
    `console.log(${JSON.stringify(databaseMarker)}+JSON.stringify({`,
    "hostContractVersion:row.host_contract_version,",
    "indexedPlugins:JSON.parse(row.plugins_json).length,",
    "migrationVersion:row.migration_version,",
    "refreshReason:row.refresh_reason",
    "}));",
    "db.close();"
  ].join("");
  const verificationInstance = await options.runWasix(options.module, {
    program: "edgejs",
    args: ["-e", databaseVerificationSource],
    cwd: "/openclaw",
    env: {
      FORCE_COLOR: "0",
      HOME: options.homeDir,
      NO_COLOR: "1",
      OPENCLAW_HOME: options.homeDir,
      OPENCLAW_STATE_DIR: options.stateDir,
      PATH: "/bin"
    },
    mount: {
      "/openclaw": options.directory
    },
    ...(options.runtime === undefined
      ? {}
      : { runtime: options.runtime })
  });
  const databaseVerificationOutput =
    await verificationInstance.wait();
  if (!databaseVerificationOutput.ok) {
    throw new Error(
      "OpenClaw postinstall database verification failed: "
      + (databaseVerificationOutput.stderr
        || databaseVerificationOutput.stdout)
    );
  }
  const databaseVerificationLine =
    databaseVerificationOutput.stdout.split(/\r?\n/u)
      .find((line) => line.startsWith(databaseMarker));
  if (!databaseVerificationLine) {
    throw new Error("OpenClaw postinstall database marker is missing");
  }
  const databaseVerification = JSON.parse(
    databaseVerificationLine.slice(databaseMarker.length)
  ) as {
    hostContractVersion: string;
    indexedPlugins: number;
    migrationVersion: number;
    refreshReason: string;
  };
  if (
    databaseVerification.hostContractVersion !== "2026.7.1-2"
    || databaseVerification.indexedPlugins !== 33
    || databaseVerification.migrationVersion !== 1
    || databaseVerification.refreshReason !== "migration"
  ) {
    throw new Error(
      "OpenClaw postinstall database contract mismatch: "
      + JSON.stringify(databaseVerification)
    );
  }

  const treeSitterWasm = await options.directory.readFile(
    "/node_modules/tree-sitter-bash/tree-sitter-bash.wasm"
  );
  const treeSitterWasmCopy = new Uint8Array(treeSitterWasm.byteLength);
  treeSitterWasmCopy.set(treeSitterWasm);
  if (!WebAssembly.validate(treeSitterWasmCopy)) {
    throw new Error("tree-sitter-bash published Wasm grammar is invalid");
  }

  return {
    schemaVersion: 1,
    status: "pass",
    executor: "@wasmer/sdk shared Directory + Edge.js QuickJS/WASIX",
    requiredEffects: {
      executions,
      packageStateDatabase: {
        bytes: database.byteLength,
        hostContractVersion: databaseVerification.hostContractVersion,
        indexedPlugins: databaseVerification.indexedPlugins,
        migrationVersion: databaseVerification.migrationVersion,
        path: databasePath,
        refreshReason: databaseVerification.refreshReason
      }
    },
    reviewedNonEffects: [
      {
        command: "echo 'preinstall: no-op'",
        disposition: "effect-proven-without-shell-execution",
        name: "preinstall",
        package: "@google/genai",
        reason: "The exact pinned command declares and performs no mutation.",
        version: "2.10.0"
      },
      {
        command: "node-gyp-build",
        disposition: "not-required-and-not-authorized",
        name: "install",
        package: "tree-sitter-bash",
        reason:
          "OpenClaw disables this native build in allowBuilds and loads the "
          + "validated published tree-sitter-bash.wasm through web-tree-sitter.",
        version: "0.25.1"
      }
    ],
    packageFiles: {
      mutated: false,
      verification:
        "clean-image postinstall completed without a prune or runtime hotfix"
    }
  };
}
