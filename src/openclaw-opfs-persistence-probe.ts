import "./style.css";
import { parseClawsemblyFs } from "./clawsemblyfs";
import {
  inspectOpenClawInstallState,
  runOpenClawInstallLifecycle
} from "./openclaw-install-lifecycle";
import {
  commitDirectoryTreeToOpfs,
  restoreDirectoryTreeFromOpfs
} from "./opfs-directory-store";

type OpenClawPackage = {
  name?: string;
  version?: string;
};

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

async function fetchBytes(
  url: string,
  label: string
): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${label} fetch failed with ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

const status = requiredElement<HTMLOutputElement>("#status");
const result = requiredElement<HTMLPreElement>("#result");
const searchParams = new URLSearchParams(location.search);
const artifactUrl = searchParams.get("artifact") ?? "/edgejs.wasm";
const imageUrl = searchParams.get("image") ?? "/openclaw.clawfs";
const phase = searchParams.get("phase");
const storeId = searchParams.get("store");
const stateDir = "/openclaw/.clawsembly-gateway-state";
const mountedStateDir = stateDir.replace(/^\/openclaw/u, "");

async function runProbe(): Promise<void> {
  try {
    if (!crossOriginIsolated) {
      throw new Error(
        "OpenClaw OPFS persistence requires cross-origin isolation"
      );
    }
    if (phase !== "write" && phase !== "read") {
      throw new Error("OPFS proof phase must be write or read");
    }
    if (!storeId) throw new Error("OPFS proof store ID is required");

    const { Directory, init, Runtime, runWasix } =
      await import("@wasmer/sdk");
    await init();
    const runtime = new Runtime({ registry: null });
    status.textContent = "Fetching Edge.js and the official package image…";
    const [edgeBytes, imageBytes] = await Promise.all([
      fetchBytes(artifactUrl, "Edge.js WASIX"),
      fetchBytes(imageUrl, "OpenClaw package image")
    ]);
    if (!WebAssembly.validate(edgeBytes)) {
      throw new Error("Chromium rejected the Edge.js WASIX module");
    }
    const parsed = parseClawsemblyFs(imageBytes);
    const packageBytes = parsed.files["/package.json"];
    if (!packageBytes) {
      throw new Error("package image is missing package.json");
    }
    const packageMetadata = JSON.parse(
      new TextDecoder().decode(packageBytes)
    ) as OpenClawPackage;
    if (
      packageMetadata.name !== "openclaw"
      || packageMetadata.version !== "2026.7.1-2"
    ) {
      throw new Error("package image contains an unexpected OpenClaw release");
    }
    const [artifactSha256, imageSha256, packageJsonSha256] =
      await Promise.all([
        sha256(edgeBytes),
        sha256(imageBytes),
        sha256(packageBytes)
      ]);
    const module = await WebAssembly.compile(edgeBytes);
    const moduleWithBytes = {
      module,
      bytes: edgeBytes
    } as unknown as WebAssembly.Module;
    const directory = new Directory(parsed.files);
    const commonEvidence = {
      schemaVersion: 1,
      crossOriginIsolated,
      browserSessionNonce: crypto.randomUUID(),
      artifact: {
        bytes: edgeBytes.byteLength,
        sha256: artifactSha256
      },
      image: {
        bytes: imageBytes.byteLength,
        files: parsed.fileCount,
        payloadBytes: parsed.payloadBytes,
        sha256: imageSha256,
        version: parsed.version
      },
      openclaw: {
        name: packageMetadata.name,
        packageJsonSha256,
        version: packageMetadata.version
      },
      stateDir,
      storeId
    };

    if (phase === "write") {
      status.textContent =
        "Creating official OpenClaw state inside the capability directory…";
      const installLifecycle = await runOpenClawInstallLifecycle({
        directory,
        homeDir: "/openclaw/.clawsembly-durable-home",
        module: moduleWithBytes,
        runWasix,
        runtime,
        stateDir
      });
      const database = await directory.readFile(
        `${mountedStateDir}/state/openclaw.sqlite`
      );
      const databaseSha256 = await sha256(database);
      status.textContent =
        "Committing the mutable capability directory to OPFS…";
      const snapshot = await commitDirectoryTreeToOpfs({
        directory,
        rootPath: mountedStateDir,
        storeId
      });
      const packageJsonAfter = await directory.readFile("/package.json");
      if (await sha256(packageJsonAfter) !== packageJsonSha256) {
        throw new Error("OPFS snapshot mutated the OpenClaw package");
      }
      const evidence = {
        ...commonEvidence,
        phase,
        status: "write-pass",
        executor:
          "@wasmer/sdk Directory -> generation-addressed OPFS snapshot",
        installLifecycle,
        databaseSha256,
        snapshot,
        packageFilesMutated: false
      };
      status.dataset.state = "pass";
      status.textContent = "PASS · OpenClaw state committed to OPFS";
      result.textContent = JSON.stringify(evidence, null, 2);
      return;
    }

    status.textContent =
      "Restoring a new capability directory from committed OPFS state…";
    const restore = await restoreDirectoryTreeFromOpfs({
      directory,
      rootPath: mountedStateDir,
      storeId
    });
    status.textContent =
      "Reopening the restored OpenClaw SQLite state in a new Edge process…";
    const packageStateDatabase = await inspectOpenClawInstallState({
      directory,
      homeDir: "/openclaw/.clawsembly-durable-home",
      module: moduleWithBytes,
      runWasix,
      runtime,
      stateDir
    });
    const database = await directory.readFile(
      `${mountedStateDir}/state/openclaw.sqlite`
    );
    const databaseSha256 = await sha256(database);
    const packageJsonAfter = await directory.readFile("/package.json");
    if (await sha256(packageJsonAfter) !== packageJsonSha256) {
      throw new Error("OPFS restore mutated the OpenClaw package");
    }
    const evidence = {
      ...commonEvidence,
      phase,
      status: "read-pass",
      executor:
        "OPFS snapshot -> new @wasmer/sdk Directory + Edge.js process",
      restore,
      packageStateDatabase,
      databaseSha256,
      packageFilesMutated: false,
      lifecycleReexecuted: false
    };
    status.dataset.state = "pass";
    status.textContent =
      "PASS · Fresh browser session recovered official OpenClaw state";
    result.textContent = JSON.stringify(evidence, null, 2);
  } catch (error) {
    status.dataset.state = "fail";
    status.textContent = "FAIL";
    result.textContent = error instanceof Error
      ? `${error.message}\n${error.stack ?? ""}`
      : String(error);
    throw error;
  }
}

void runProbe();
