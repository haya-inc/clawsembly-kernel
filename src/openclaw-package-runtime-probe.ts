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

type StreamCapture = {
  cancel: () => Promise<void>;
  done: Promise<void>;
  snapshot: () => string;
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
    output.stderr.includes(
      "gateway bind=loopback resolved to non-loopback host 0.0.0.0"
    )
  ) {
    return "loopback-networking-resolved-to-wildcard";
  }
  if (
    output.code === 125
    && output.stderr.includes(gatewayHostTimeoutMarker)
  ) {
    return "gateway-host-diagnostic-deadline";
  }
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

function captureStream(
  stream: ReadableStream<Uint8Array>
): StreamCapture {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let captured = "";
  const done = (async () => {
    try {
      for (;;) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        captured += decoder.decode(value, { stream: true });
      }
      captured += decoder.decode();
    } finally {
      reader.releaseLock();
    }
  })();
  return {
    cancel: async () => {
      try {
        await reader.cancel();
      } catch {
        // The runtime may close the pipe concurrently with the watchdog.
      }
    },
    done,
    snapshot: () => captured
  };
}

const status = requiredElement<HTMLOutputElement>("#status");
const result = requiredElement<HTMLPreElement>("#result");
const searchParams = new URLSearchParams(location.search);
const artifactUrl = searchParams.get("artifact") ?? "/edgejs.wasm";
const imageUrl = searchParams.get("image") ?? "/openclaw.clawfs";
const runtimeMode = searchParams.get("mode") === "gateway"
  ? "gateway"
  : "version";
const requestedGatewayDiagnosticTimeoutMs = Number(
  searchParams.get("timeoutMs")
);
const gatewayDiagnosticTimeoutMs =
  Number.isSafeInteger(requestedGatewayDiagnosticTimeoutMs)
    && requestedGatewayDiagnosticTimeoutMs >= 1_000
    && requestedGatewayDiagnosticTimeoutMs <= 120_000
    ? requestedGatewayDiagnosticTimeoutMs
    : 12_000;
const gatewayTimeoutMarker =
  `CLAWSEMBLY_GATEWAY_DIAGNOSTIC_TIMEOUT=${gatewayDiagnosticTimeoutMs}`;
const gatewayHostTimeoutMs = gatewayDiagnosticTimeoutMs + 5_000;
const gatewayHostTimeoutMarker =
  `CLAWSEMBLY_GATEWAY_HOST_TIMEOUT=${gatewayHostTimeoutMs}`;

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
      "token",
      "--bind",
      "loopback",
      "--port",
      "18789",
      "--tailscale",
      "off",
      "--verbose",
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
        ...(runtimeMode === "gateway"
          ? {
              OPENCLAW_GATEWAY_TOKEN:
                "clawsembly-diagnostic-non-secret-token",
              OPENCLAW_GATEWAY_STARTUP_TRACE: "1",
              OPENCLAW_NO_RESPAWN: "1"
            }
          : {}),
        OPENCLAW_STATE_DIR: "/openclaw/.clawsembly-state",
        PATH: "/bin"
      },
      mount: {
        "/openclaw": openclaw
      }
    });
    const stdoutCapture = captureStream(instance.stdout);
    const stderrCapture = captureStream(instance.stderr);
    let hostTimeout: number | undefined;
    const execution = await Promise.race([
      instance.wait().then((output) => ({
        kind: "exit" as const,
        output: output as WasixOutput
      })),
      new Promise<{ kind: "host-timeout" }>((resolve) => {
        hostTimeout = window.setTimeout(
          () => resolve({ kind: "host-timeout" }),
          gatewayHostTimeoutMs
        );
      })
    ]);
    if (hostTimeout !== undefined) window.clearTimeout(hostTimeout);
    let output: WasixOutput;
    if (execution.kind === "host-timeout") {
      output = {
        code: 125,
        ok: false,
        stdout: stdoutCapture.snapshot(),
        stderr:
          stderrCapture.snapshot()
          + `${gatewayHostTimeoutMarker}\n`
      };
      await Promise.allSettled([
        stdoutCapture.cancel(),
        stderrCapture.cancel()
      ]);
    } else {
      await Promise.all([stdoutCapture.done, stderrCapture.done]);
      output = {
        ...execution.output,
        stdout: stdoutCapture.snapshot(),
        stderr: stderrCapture.snapshot()
      };
    }
    const gatewayTimedOut =
      runtimeMode === "gateway"
      && (
        output.code === 124
        && output.stderr.includes(gatewayTimeoutMarker)
        || output.code === 125
        && output.stderr.includes(gatewayHostTimeoutMarker)
      );
    const gatewayReturnedWithoutReadiness =
      runtimeMode === "gateway"
      && output.ok
      && !gatewayTimedOut;
    const runtimeNodeVersion = /^CLAWSEMBLY_DIAGNOSTIC_NODE=(.+)$/mu
      .exec(output.stderr)?.[1];
    const evidence = {
      schemaVersion: 1,
      status: gatewayTimedOut
        ? "diagnostic-timeout"
        : gatewayReturnedWithoutReadiness
          ? "blocked"
          : output.ok
            ? "diagnostic-pass"
            : "blocked",
      executionMode: runtimeMode === "gateway"
        ? "timer-bounded-unmodified-gateway-diagnostic"
        : "direct-unmodified-entry-diagnostic",
      notSuccessReason:
        "The official launcher Node-version gate was deliberately bypassed "
        + "only to identify the next compatibility boundary; Gateway "
        + "readiness requires a successful client connection.",
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
              timeoutMs: gatewayDiagnosticTimeoutMs,
              hostTimeoutMs: gatewayHostTimeoutMs
            }
          : {})
      },
      ...(runtimeNodeVersion
        ? { runtime: { node: runtimeNodeVersion } }
        : {}),
      result: output,
      blocker: gatewayReturnedWithoutReadiness
        ? "gateway-returned-without-readiness-evidence"
        : classifyBlocker(output),
      firstDiagnosticLine: firstDiagnosticLine(output)
    };
    status.dataset.state = "pass";
    status.textContent = gatewayTimedOut
      ? "MILESTONE · Gateway path remained live until the diagnostic deadline"
      : gatewayReturnedWithoutReadiness
        ? "MILESTONE · Gateway returned without client-visible readiness"
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
