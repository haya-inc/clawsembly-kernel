import "./style.css";

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

const status = requiredElement<HTMLOutputElement>("#status");
const result = requiredElement<HTMLPreElement>("#result");
const searchParams = new URLSearchParams(location.search);
const artifactUrl = searchParams.get("artifact") ?? "/edgejs.wasm";
const launcherUrl = searchParams.get("launcher") ?? "/openclaw/openclaw.mjs";
const packageUrl = searchParams.get("package") ?? "/openclaw/package.json";

type OpenClawPackage = {
  engines?: {
    node?: string;
  };
  version?: string;
};

async function fetchBytes(
  url: string,
  label: string
): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${label} fetch failed with ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function runProbe(): Promise<void> {
  try {
    if (!crossOriginIsolated) {
      throw new Error("OpenClaw WASIX requires a cross-origin-isolated browser context");
    }
    const { Directory, init, initializeLogger, runWasix } =
      await import("@wasmer/sdk");
    await init();
    if (searchParams.get("debug") === "1") initializeLogger("debug");

    status.textContent = "Fetching the Edge.js and OpenClaw artifacts…";
    const [edgeBytes, launcherBytes, packageBytes] = await Promise.all([
      fetchBytes(artifactUrl, "Edge.js WASIX"),
      fetchBytes(launcherUrl, "OpenClaw launcher"),
      fetchBytes(packageUrl, "OpenClaw package metadata")
    ]);
    if (!WebAssembly.validate(edgeBytes)) {
      throw new Error("Chromium rejected the Edge.js WASIX module");
    }

    const openclaw = new Directory();
    await openclaw.writeFile("/openclaw.mjs", launcherBytes);
    await openclaw.writeFile("/package.json", packageBytes);
    const packageMetadata = JSON.parse(
      new TextDecoder().decode(packageBytes)
    ) as OpenClawPackage;
    if (!packageMetadata.version || !packageMetadata.engines?.node) {
      throw new Error("OpenClaw package metadata has no version or Node engine");
    }
    const module = await WebAssembly.compile(edgeBytes);

    status.textContent = "Starting the official OpenClaw entrypoint…";
    const moduleWithBytes = {
      module,
      bytes: edgeBytes
    } as unknown as WebAssembly.Module;
    const instance = await runWasix(moduleWithBytes, {
      program: "edgejs",
      args: ["/openclaw/openclaw.mjs", "--version"],
      mount: {
        "/openclaw": openclaw
      }
    });
    const output = await instance.wait();

    const versionLine = output.stdout.trim();
    const versionMatch = /^OpenClaw (.+)$/u.exec(versionLine);
    if (output.ok && versionMatch) {
      const evidence = {
        schemaVersion: 1,
        status: "pass",
        crossOriginIsolated,
        executor: "@wasmer/sdk",
        artifactBytes: edgeBytes.byteLength,
        launcherBytes: launcherBytes.byteLength,
        version: versionMatch[1],
        stdout: output.stdout,
        stderr: output.stderr,
        exitCode: output.code
      };
      status.dataset.state = "pass";
      status.textContent = "PASS · Official OpenClaw entrypoint executed";
      result.textContent = JSON.stringify(evidence, null, 2);
      return;
    }

    const requiredNodeEngine = packageMetadata.engines.node;
    const versionGate = new RegExp(
      String.raw`^openclaw: Node\.js (.+) is required `
      + String.raw`\(current: (v[^)]+)\)\.`,
      "u"
    ).exec(output.stderr);
    const launcherNodeRange = versionGate?.[1];
    const normalizedLauncherNodeRange = launcherNodeRange
      ?.replace(/, or /gu, " || ")
      .replace(/, /gu, " || ");
    if (
      output.code === 1
      && output.stdout === ""
      && versionGate
      && normalizedLauncherNodeRange === requiredNodeEngine
      && !output.stderr.includes("missing dist/entry")
    ) {
      const evidence = {
        schemaVersion: 1,
        status: "blocked",
        blocker: "node-version-gate",
        crossOriginIsolated,
        executor: "@wasmer/sdk",
        artifactBytes: edgeBytes.byteLength,
        launcherBytes: launcherBytes.byteLength,
        version: packageMetadata.version,
        requiredNodeEngine,
        launcherNodeRange,
        actualNodeVersion: versionGate[2],
        stdout: output.stdout,
        stderr: output.stderr,
        exitCode: output.code
      };
      status.dataset.state = "pass";
      status.textContent =
        "MILESTONE · Official OpenClaw launcher stopped at its Node version gate";
      result.textContent = JSON.stringify(evidence, null, 2);
      return;
    }

    if (!output.ok) {
      throw new Error(
        `OpenClaw entrypoint exited with ${output.code}\n`
        + `stdout:\n${output.stdout}\n`
        + `stderr:\n${output.stderr}`
      );
    }
    throw new Error(`Unexpected OpenClaw version output: ${output.stdout}`);
  } catch (error) {
    status.dataset.state = "fail";
    status.textContent = "FAIL";
    result.textContent = error instanceof Error
      ? `${error.message}\n${error.stack ?? ""}`
      : String(error);
  }
}

void runProbe();
