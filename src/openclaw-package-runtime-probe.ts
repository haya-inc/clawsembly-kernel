import "./style.css";
import { parseClawsemblyFs } from "./clawsemblyfs";

type OpenClawPackage = {
  engines?: {
    node?: string;
  };
  name?: string;
  version?: string;
};

type WasixOutput = {
  code: number;
  ok: boolean;
  stderr: string;
  stdout: string;
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

function firstDiagnosticLine(output: WasixOutput): string | undefined {
  return `${output.stderr}\n${output.stdout}`
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("CLAWSEMBLY_"));
}

function classifyBlocker(output: WasixOutput): string | undefined {
  if (
    output.code === 124
    && output.stderr.includes(gatewayTimeoutMarker)
  ) {
    return "gateway-diagnostic-deadline";
  }
  if (
    output.stderr.includes(
      "SQLite support is unavailable or unsafe in this Node runtime."
    )
  ) {
    return "node-sqlite-unavailable-or-unsafe";
  }
  if (
    output.stderr.includes("openclaw requires Node ")
    && output.stderr.includes("Detected: node ")
  ) {
    return "node-version-floor";
  }
  return output.ok ? undefined : "unclassified-runtime-failure";
}

const status = requiredElement<HTMLOutputElement>("#status");
const result = requiredElement<HTMLPreElement>("#result");
const searchParams = new URLSearchParams(location.search);
const artifactUrl = searchParams.get("artifact") ?? "/edgejs.wasm";
const imageUrl = searchParams.get("image") ?? "/openclaw.clawfs";
const runtimeMode = searchParams.get("mode") === "gateway"
  ? "gateway"
  : "version";
const gatewayDiagnosticTimeoutMs = 12_000;
const gatewayTimeoutMarker =
  `CLAWSEMBLY_GATEWAY_DIAGNOSTIC_TIMEOUT=${gatewayDiagnosticTimeoutMs}`;

async function runProbe(): Promise<void> {
  try {
    if (!crossOriginIsolated) {
      throw new Error(
        "OpenClaw WASIX requires a cross-origin-isolated browser context"
      );
    }
    const { Directory, init, initializeLogger, runWasix } =
      await import("@wasmer/sdk");
    await init();
    if (searchParams.get("debug") === "1") initializeLogger("debug");

    status.textContent = "Fetching Edge.js and the complete package image…";
    const [edgeBytes, imageBytes] = await Promise.all([
      fetchBytes(artifactUrl, "Edge.js WASIX"),
      fetchBytes(imageUrl, "OpenClaw package image")
    ]);
    if (!WebAssembly.validate(edgeBytes)) {
      throw new Error("Chromium rejected the Edge.js WASIX module");
    }

    status.textContent = "Verifying and mounting the complete package graph…";
    const parsed = parseClawsemblyFs(imageBytes);
    const packageBytes = parsed.files["/package.json"];
    const launcherBytes = parsed.files["/openclaw.mjs"];
    const entryBytes = parsed.files["/dist/entry.js"];
    if (!packageBytes || !launcherBytes || !entryBytes) {
      throw new Error("package image is missing an official entrypoint file");
    }
    const packageMetadata = JSON.parse(
      new TextDecoder().decode(packageBytes)
    ) as OpenClawPackage;
    if (
      packageMetadata.name !== "openclaw"
      || !packageMetadata.version
      || !packageMetadata.engines?.node
    ) {
      throw new Error("package image does not contain valid OpenClaw metadata");
    }
    const openclaw = new Directory(parsed.files);
    const module = await WebAssembly.compile(edgeBytes);
    const moduleWithBytes = {
      module,
      bytes: edgeBytes
    } as unknown as WebAssembly.Module;

    const gatewayArgs = [
      "gateway",
      "run",
      "--dev",
      "--allow-unconfigured",
      "--auth",
      "none",
      "--bind",
      "loopback",
      "--port",
      "18789",
      "--tailscale",
      "off",
      "--ws-log",
      "compact"
    ];
    const guestArgv = runtimeMode === "gateway"
      ? ["/bin/edge", "/openclaw/dist/entry.js", ...gatewayArgs]
      : undefined;
    const gatewayHarness = runtimeMode === "gateway"
      ? [
          `process.argv = ${JSON.stringify(guestArgv)};`,
          "console.error(",
          `${JSON.stringify("CLAWSEMBLY_DIAGNOSTIC_NODE=")}`,
          "+ process.versions.node);",
          "setTimeout(() => {",
          `console.error(${JSON.stringify(gatewayTimeoutMarker)});`,
          "process.exit(124);",
          `}, ${gatewayDiagnosticTimeoutMs});`,
          `import(${JSON.stringify("file:///openclaw/dist/entry.js")})`,
          ".catch((error) => {",
          "console.error(error?.stack ?? String(error));",
          "process.exit(1);",
          "});"
        ].join("")
      : undefined;
    const edgeArgs = runtimeMode === "gateway"
      ? ["-e", gatewayHarness!]
      : ["/openclaw/dist/entry.js", "--version"];

    status.textContent = runtimeMode === "gateway"
      ? "Starting the real Gateway path with a bounded diagnostic harness…"
      : "Invoking the exact unmodified dist/entry.js…";
    const instance = await runWasix(moduleWithBytes, {
      program: "edgejs",
      args: edgeArgs,
      cwd: "/openclaw",
      env: {
        CLAWSEMBLY_DIAGNOSTIC_ONLY: "1",
        FORCE_COLOR: "0",
        HOME: "/openclaw/.clawsembly-home",
        NO_COLOR: "1",
        ...(runtimeMode === "gateway" ? { OPENCLAW_DEBUG: "1" } : {}),
        OPENCLAW_STATE_DIR: "/openclaw/.clawsembly-state",
        PATH: "/bin"
      },
      mount: {
        "/openclaw": openclaw
      }
    });
    const output = await instance.wait() as WasixOutput;
    const gatewayTimedOut =
      runtimeMode === "gateway"
      && output.code === 124
      && output.stderr.includes(gatewayTimeoutMarker);
    const runtimeNodeVersion = /^CLAWSEMBLY_DIAGNOSTIC_NODE=(.+)$/mu
      .exec(output.stderr)?.[1];
    const evidence = {
      schemaVersion: 1,
      status: gatewayTimedOut
        ? "diagnostic-timeout"
        : output.ok
          ? "diagnostic-pass"
          : "blocked",
      executionMode: runtimeMode === "gateway"
        ? "timer-bounded-unmodified-gateway-diagnostic"
        : "direct-unmodified-entry-diagnostic",
      notSuccessReason:
        "The official launcher Node-version gate was deliberately bypassed "
        + "only to identify the next compatibility boundary.",
      crossOriginIsolated,
      executor: "@wasmer/sdk + Edge.js QuickJS/WASIX",
      image: {
        bytes: imageBytes.byteLength,
        files: parsed.fileCount,
        payloadBytes: parsed.payloadBytes,
        version: parsed.version
      },
      openclaw: {
        name: packageMetadata.name,
        version: packageMetadata.version,
        nodeEngine: packageMetadata.engines.node,
        packageJsonSha256: await sha256(packageBytes),
        launcherBytes: launcherBytes.byteLength,
        launcherSha256: await sha256(launcherBytes),
        entryBytes: entryBytes.byteLength,
        entrySha256: await sha256(entryBytes)
      },
      invocation: {
        program: "edgejs",
        entry: "/openclaw/dist/entry.js",
        args: runtimeMode === "gateway" ? gatewayArgs : ["--version"],
        ...(runtimeMode === "gateway"
          ? {
              harness: "timer-bounded dynamic import with guest argv",
              timeoutMs: gatewayDiagnosticTimeoutMs
            }
          : {})
      },
      ...(runtimeNodeVersion
        ? { runtime: { node: runtimeNodeVersion } }
        : {}),
      result: output,
      blocker: classifyBlocker(output),
      firstDiagnosticLine: firstDiagnosticLine(output)
    };
    status.dataset.state = "pass";
    status.textContent = gatewayTimedOut
      ? "MILESTONE · Gateway path remained live until the diagnostic deadline"
      : output.ok
        ? "MILESTONE · Unmodified dist/entry.js completed its diagnostic path"
        : "MILESTONE · Next unmodified entry compatibility blocker captured";
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
