import "./style.css";

type EdgeVersions = {
  edge: string;
  node: string;
  v8: string;
};

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

const status = requiredElement<HTMLOutputElement>("#status");
const result = requiredElement<HTMLPreElement>("#result");
const searchParams = new URLSearchParams(location.search);
const artifactUrl = searchParams.get("artifact")
  ?? "/edgejs.wasm";
const marker = "clawsembly-edgejs-wasix-browser";
const markerPrefix = "CLAWSEMBLY_EDGE_WASIX=";

async function runProbe(): Promise<void> {
  try {
    if (!crossOriginIsolated) {
      throw new Error("Edge.js WASIX requires a cross-origin-isolated browser context");
    }
    const { init, initializeLogger, runWasix } = await import("@wasmer/sdk");
    await init();
    if (searchParams.get("debug") === "1") initializeLogger("debug");
    status.textContent = "Fetching the self-built Edge.js WASIX artifact…";
    const response = await fetch(artifactUrl);
    if (!response.ok) {
      throw new Error(`Edge.js WASIX fetch failed with ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!WebAssembly.validate(bytes)) {
      throw new Error("Chromium rejected the Edge.js WASIX module");
    }
    const module = await WebAssembly.compile(bytes);
    status.textContent = "Starting Edge.js inside the browser…";
    const runtimeScript = [
      `console.log(${JSON.stringify(markerPrefix)} + JSON.stringify({`,
      `marker: ${JSON.stringify(marker)},`,
      "edge: process.versions.edge,",
      "node: process.versions.node,",
      "v8: process.versions.v8",
      "}))"
    ].join("");
    const moduleWithBytes = { module, bytes } as unknown as WebAssembly.Module;
    const instance = await runWasix(moduleWithBytes, {
      program: "edgejs",
      args: ["-e", runtimeScript]
    });
    const output = await instance.wait();
    if (!output.ok) {
      throw new Error(
        `Edge.js WASIX exited with ${output.code}: ${output.stderr || output.stdout}`
      );
    }
    const markerLine = output.stdout
      .split(/\r?\n/u)
      .find((line) => line.startsWith(markerPrefix));
    if (!markerLine) {
      throw new Error(`Edge.js emitted no runtime marker: ${output.stdout}`);
    }
    const runtime = JSON.parse(markerLine.slice(markerPrefix.length)) as
      EdgeVersions & { marker: string };
    if (runtime.marker !== marker) {
      throw new Error(`Unexpected Edge.js marker: ${runtime.marker}`);
    }

    const evidence = {
      schemaVersion: 1,
      status: "pass",
      crossOriginIsolated,
      executor: "@wasmer/sdk",
      artifactBytes: bytes.byteLength,
      runtime,
      exitCode: output.code,
      stderr: output.stderr
    };
    status.dataset.state = "pass";
    status.textContent = "PASS · Edge.js started inside the browser";
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
