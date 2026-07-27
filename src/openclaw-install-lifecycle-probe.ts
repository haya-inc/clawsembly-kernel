import "./style.css";
import { parseClawsemblyFs } from "./clawsemblyfs";
import { runOpenClawInstallLifecycle } from "./openclaw-install-lifecycle";

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

async function runProbe(): Promise<void> {
  try {
    if (!crossOriginIsolated) {
      throw new Error(
        "OpenClaw lifecycle proof requires a cross-origin-isolated context"
      );
    }
    const { Directory, init, Runtime, runWasix } =
      await import("@wasmer/sdk");
    await init();
    const runtime = new Runtime({ registry: null });

    status.textContent = "Fetching the runtime and official package image…";
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
    ) as { name?: string; version?: string };
    if (
      packageMetadata.name !== "openclaw"
      || packageMetadata.version !== "2026.7.1-2"
    ) {
      throw new Error("package image identity does not match the lifecycle proof");
    }

    const directory = new Directory(parsed.files);
    const module = await WebAssembly.compile(edgeBytes);
    const moduleWithBytes = {
      module,
      bytes: edgeBytes
    } as unknown as WebAssembly.Module;
    status.textContent =
      "Executing required install effects inside the browser kernel…";
    const lifecycle = await runOpenClawInstallLifecycle({
      directory,
      homeDir: "/openclaw/.clawsembly-install-home",
      module: moduleWithBytes,
      runWasix,
      runtime,
      stateDir: "/openclaw/.clawsembly-install-state"
    });

    const evidence = {
      schemaVersion: 1,
      status: "pass",
      crossOriginIsolated,
      artifact: {
        bytes: edgeBytes.byteLength,
        sha256: await sha256(edgeBytes)
      },
      image: {
        bytes: imageBytes.byteLength,
        files: parsed.fileCount,
        payloadBytes: parsed.payloadBytes,
        sha256: await sha256(imageBytes),
        version: parsed.version
      },
      openclaw: {
        name: packageMetadata.name,
        packageJsonSha256: await sha256(packageBytes),
        version: packageMetadata.version
      },
      lifecycle,
      notNorthStarCompletion:
        "This closes the required package lifecycle-effect gate for the "
        + "pinned release; live-provider TLS and durable fresh-session OPFS "
        + "recovery remain separate gates."
    };
    status.dataset.state = "pass";
    status.textContent =
      "PASS · Required OpenClaw install effects completed in Chromium";
    result.textContent = JSON.stringify(evidence, null, 2);
  } catch (error) {
    status.dataset.state = "fail";
    status.textContent = "FAIL";
    result.textContent = error instanceof Error
      ? `${error.message}\n${error.stack ?? ""}`
      : String(error);
  }
}

void runProbe();
