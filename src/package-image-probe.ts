import "./style.css";
import { parseClawsemblyFs } from "./clawsemblyfs";

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

function decodeJson(bytes: Uint8Array, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not a JSON object`);
  }
  return value as Record<string, unknown>;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const source = new Uint8Array(bytes.byteLength);
  source.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", source);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

const status = requiredElement<HTMLOutputElement>("#status");
const result = requiredElement<HTMLPreElement>("#result");
const searchParams = new URLSearchParams(location.search);
const imageUrl = searchParams.get("image") ?? "/openclaw.clawfs";

async function runProbe(): Promise<void> {
  try {
    if (!crossOriginIsolated) {
      throw new Error(
        "The OpenClaw package image requires a cross-origin-isolated browser context"
      );
    }
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`package image fetch failed with ${response.status}`);
    }
    const imageBytes = new Uint8Array(await response.arrayBuffer());

    status.textContent = "Parsing all package files…";
    const parsed = parseClawsemblyFs(imageBytes);
    const { Directory, init } = await import("@wasmer/sdk");
    await init();

    status.textContent = "Mounting the complete runtime graph…";
    const directory = new Directory(parsed.files);
    const [
      packageJsonBytes,
      shrinkwrapBytes,
      launcherBytes,
      entryBytes,
      dependencyManifestBytes
    ] = await Promise.all([
      directory.readFile("/package.json"),
      directory.readFile("/npm-shrinkwrap.json"),
      directory.readFile("/openclaw.mjs"),
      directory.readFile("/dist/entry.js"),
      directory.readFile("/node_modules/chalk/package.json")
    ]);
    const packageJson = decodeJson(packageJsonBytes, "package.json");
    const dependencyManifest = decodeJson(
      dependencyManifestBytes,
      "chalk package.json"
    );
    if (
      packageJson.name !== "openclaw"
      || typeof packageJson.version !== "string"
      || dependencyManifest.name !== "chalk"
    ) {
      throw new Error("mounted package identity did not match OpenClaw");
    }

    const evidence = {
      schemaVersion: 1,
      status: "pass",
      crossOriginIsolated,
      executor: "@wasmer/sdk Directory",
      image: {
        bytes: imageBytes.byteLength,
        files: parsed.fileCount,
        payloadBytes: parsed.payloadBytes,
        version: parsed.version
      },
      openclaw: {
        name: packageJson.name,
        version: packageJson.version,
        packageJsonSha256: await sha256(packageJsonBytes),
        shrinkwrapSha256: await sha256(shrinkwrapBytes),
        launcherBytes: launcherBytes.byteLength,
        launcherSha256: await sha256(launcherBytes),
        entryBytes: entryBytes.byteLength,
        entrySha256: await sha256(entryBytes)
      },
      dependencySample: {
        name: dependencyManifest.name,
        version: dependencyManifest.version
      }
    };
    status.dataset.state = "pass";
    status.textContent = "PASS · Complete OpenClaw package image mounted";
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
