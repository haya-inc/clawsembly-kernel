import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browserContract = JSON.parse(
  await readFile(
    path.join(root, "contracts", "edgejs-browser-build.json"),
    "utf8"
  )
);

function parseArguments(argv) {
  const options = {
    evidence: undefined,
    input: undefined,
    output: undefined,
    targetVersion: "24.15.0"
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--evidence" && value) {
      options.evidence = path.resolve(value);
      index += 1;
    } else if (argument === "--input" && value) {
      options.input = path.resolve(value);
      index += 1;
    } else if (argument === "--output" && value) {
      options.output = path.resolve(value);
      index += 1;
    } else if (argument === "--target-version" && value) {
      options.targetVersion = value;
      index += 1;
    } else {
      throw new Error(`unknown or incomplete argument: ${argument}`);
    }
  }
  if (!options.input || !options.output) {
    throw new Error("--input and --output are required");
  }
  options.evidence ??= `${options.output}.evidence.json`;
  return options;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function allOffsets(bytes, needle) {
  const offsets = [];
  let cursor = 0;
  while (cursor <= bytes.byteLength - needle.byteLength) {
    const offset = bytes.indexOf(needle, cursor);
    if (offset < 0) break;
    offsets.push(offset);
    cursor = offset + needle.byteLength;
  }
  return offsets;
}

async function writeAtomic(filename, bytes) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, bytes, { mode: 0o600 });
    await rename(temporary, filename);
    await chmod(filename, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const sourceVersion = browserContract.expectedRuntime.node;
  if (
    !/^\d+\.\d+\.\d+$/u.test(sourceVersion)
    || !/^\d+\.\d+\.\d+$/u.test(options.targetVersion)
  ) {
    throw new Error("source and target Node versions must be numeric semver");
  }
  const sourcePattern = Buffer.from(sourceVersion, "ascii");
  const targetPattern = Buffer.from(options.targetVersion, "ascii");
  if (sourcePattern.byteLength !== targetPattern.byteLength) {
    throw new Error(
      "diagnostic replacement must preserve the WebAssembly byte length"
    );
  }

  const sourceBytes = await readFile(options.input);
  if (!WebAssembly.validate(sourceBytes)) {
    throw new Error("input is not a valid WebAssembly module");
  }
  const offsets = allOffsets(sourceBytes, sourcePattern);
  if (offsets.length === 0) {
    throw new Error(
      `input contains no exact ${JSON.stringify(sourceVersion)} version bytes`
    );
  }
  if (allOffsets(sourceBytes, targetPattern).length !== 0) {
    throw new Error(
      `input already contains target version ${options.targetVersion}`
    );
  }

  const diagnosticBytes = Buffer.from(sourceBytes);
  for (const offset of offsets) targetPattern.copy(diagnosticBytes, offset);
  if (
    allOffsets(diagnosticBytes, sourcePattern).length !== 0
    || allOffsets(diagnosticBytes, targetPattern).length !== offsets.length
    || diagnosticBytes.byteLength !== sourceBytes.byteLength
    || !WebAssembly.validate(diagnosticBytes)
  ) {
    throw new Error("diagnostic version replacement failed validation");
  }

  const evidence = {
    schemaVersion: 1,
    status: "diagnostic-only",
    claim:
      "This byte-for-byte-derived Edge.js artifact changes only equal-length "
      + "embedded Node version labels to expose the next OpenClaw compatibility "
      + "boundary. It does not claim Node 24.15 compatibility and cannot "
      + "satisfy the Clawsembly North Star.",
    source: {
      path: options.input,
      bytes: sourceBytes.byteLength,
      sha256: sha256(sourceBytes),
      nodeVersion: sourceVersion
    },
    diagnostic: {
      path: options.output,
      bytes: diagnosticBytes.byteLength,
      sha256: sha256(diagnosticBytes),
      nodeVersion: options.targetVersion
    },
    mutation: {
      equalLength: true,
      occurrences: offsets.length,
      offsets
    }
  };
  await writeAtomic(options.output, diagnosticBytes);
  await writeAtomic(
    options.evidence,
    Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`)
  );
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

await main();
