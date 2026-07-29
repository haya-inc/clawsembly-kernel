import { chromium } from "@playwright/test";
import process from "node:process";

function parseArguments(argv) {
  const values = {
    baseUrl:
      process.env.CLAWSEMBLY_DEPLOYMENT_URL
      ?? "https://clawsembly.yhay81.com",
    skipBrowser: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--skip-browser") {
      values.skipBrowser = true;
      continue;
    }
    if (name === "--base-url") {
      const value = argv[index + 1];
      if (!value) throw new Error("Missing value for --base-url");
      values.baseUrl = value;
      index += 1;
      continue;
    }
    throw new Error(`Unexpected argument: ${name}`);
  }
  return values;
}

const requiredIsolationHeaders = {
  "cross-origin-embedder-policy": "require-corp",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "x-content-type-options": "nosniff"
};

function requireHeader(response, name, expected) {
  const actual = response.headers.get(name);
  if (actual !== expected) {
    throw new Error(
      `${response.url} returned ${name}: ${JSON.stringify(actual)}; `
      + `expected ${JSON.stringify(expected)}`
    );
  }
}

async function fetchRequired(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  return response;
}

async function verifyHttp(baseUrl) {
  const root = await fetchRequired(new URL("/", baseUrl));
  for (const [name, value] of Object.entries(requiredIsolationHeaders)) {
    requireHeader(root, name, value);
  }

  const health = await fetchRequired(new URL("/healthz", baseUrl));
  const healthJson = await health.json();
  if (
    healthJson.status !== "ok"
    || healthJson.service !== "clawsembly-kernel"
  ) {
    throw new Error("Unexpected deployment health response");
  }

  const manifestResponse = await fetchRequired(
    new URL("/runtime-manifest.json", baseUrl)
  );
  const manifest = await manifestResponse.json();
  if (
    manifest.schemaVersion !== 1
    || !manifest.artifacts?.edgejs
    || !manifest.artifacts?.openclaw
  ) {
    throw new Error("Invalid deployed runtime manifest");
  }

  for (const artifact of Object.values(manifest.artifacts)) {
    for (const artifactPath of [
      artifact.aliasPath,
      artifact.publicPath
    ]) {
      const response = await fetchRequired(
        new URL(artifactPath, baseUrl),
        {
          method: "HEAD",
          headers: {
            "Accept-Encoding": "identity"
          }
        }
      );
      requireHeader(response, "content-type", artifact.contentType);
      requireHeader(response, "content-length", String(artifact.bytes));
      requireHeader(response, "x-clawsembly-sha256", artifact.sha256);
      requireHeader(response, "x-clawsembly-release", manifest.release);
      requireHeader(
        response,
        "etag",
        `"sha256-${artifact.sha256}"`
      );
    }

    const range = await fetchRequired(
      new URL(artifact.publicPath, baseUrl),
      {
        headers: {
          "Accept-Encoding": "identity",
          Range: "bytes=0-15"
        }
      }
    );
    if (range.status !== 206) {
      throw new Error(
        `${artifact.publicPath} range request returned ${range.status}`
      );
    }
    requireHeader(
      range,
      "content-range",
      `bytes 0-15/${artifact.bytes}`
    );
    if ((await range.arrayBuffer()).byteLength !== 16) {
      throw new Error(`${artifact.publicPath} returned an invalid range`);
    }
  }

  return manifest;
}

async function waitForProbe(page, pathname, timeoutMs) {
  await page.goto(pathname);
  await page.waitForFunction(
    () => {
      const state = document.querySelector("#status")?.getAttribute(
        "data-state"
      );
      return state === "pass" || state === "fail";
    },
    undefined,
    { timeout: timeoutMs }
  );
  const state = await page.locator("#status").getAttribute("data-state");
  const resultText = await page.locator("#result").textContent() ?? "";
  if (state !== "pass") {
    throw new Error(
      `Browser probe ${pathname} failed:\n${resultText}`
    );
  }
  let evidence;
  try {
    evidence = JSON.parse(resultText);
  } catch {
    evidence = { resultText };
  }
  return evidence;
}

async function verifyBrowser(baseUrl, manifest) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      baseURL: baseUrl.toString()
    });
    const page = await context.newPage();
    const errors = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));

    const stateEvidence = await waitForProbe(page, "/", 120_000);
    if (
      stateEvidence.status !== "pass"
      || stateEvidence.crossOriginIsolated !== true
    ) {
      throw new Error("Deployed state probe did not prove isolation");
    }

    const runtimeEvidence = await waitForProbe(
      page,
      "/package-runtime-probe.html"
      + "?artifact=/edgejs.wasm"
      + "&image=/openclaw.clawfs",
      900_000
    );
    if (
      runtimeEvidence.status !== "pass"
      || runtimeEvidence.crossOriginIsolated !== true
      || runtimeEvidence.openclaw?.version !== manifest.openclaw.version
      || runtimeEvidence.runtime?.node
        !== manifest.nodeCompatibility.version
    ) {
      throw new Error(
        "Deployed browser runtime evidence did not match the manifest"
      );
    }
    if (errors.length > 0) {
      throw new Error(
        `Browser emitted errors:\n${errors.join("\n")}`
      );
    }
    await context.close();
    return {
      stateEvidence,
      runtimeEvidence
    };
  } finally {
    await browser.close();
  }
}

async function main() {
  const argumentsMap = parseArguments(process.argv.slice(2));
  const baseUrl = new URL(argumentsMap.baseUrl);
  if (baseUrl.protocol !== "https:") {
    throw new Error("Deployment verification requires HTTPS");
  }

  const manifest = await verifyHttp(baseUrl);
  const browser = argumentsMap.skipBrowser
    ? undefined
    : await verifyBrowser(baseUrl, manifest);

  console.log(JSON.stringify({
    schemaVersion: 1,
    status: "cloudflare-production-pass",
    baseUrl: baseUrl.toString(),
    release: manifest.release,
    sourceCommit: manifest.sourceCommit,
    proofRunUrl: manifest.proof.runUrl,
    artifacts: manifest.artifacts,
    browser
  }, null, 2));
}

await main();
