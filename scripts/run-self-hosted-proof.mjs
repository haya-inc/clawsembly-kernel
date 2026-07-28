#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  open,
  stat
} from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import process from "node:process";

const expected = {
  llamaServerSha256:
    "77eb1229a117e3034b873a46382bffcecc0f9815bd14e825a0706f8fc0b07564",
  modelBytes: 491_400_032,
  modelSha256:
    "74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db"
};

function usage(message) {
  if (message) process.stderr.write(`error: ${message}\n\n`);
  process.stderr.write(`Usage:
  npm run self-host:prove -- \\
    --edge PATH --image PATH --relay PATH --broker PATH \\
    --llama-server PATH --model PATH

The command verifies the pinned llama.cpp binary and Qwen GGUF before running
the complete unmodified OpenClaw browser proof.
`);
  process.exit(message ? 2 : 0);
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") usage();
    if (!argument.startsWith("--")) usage(`unknown argument ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      usage(`${argument} requires a path`);
    }
    values[argument.slice(2)] = path.resolve(value);
    index += 1;
  }
  for (const name of [
    "edge",
    "image",
    "relay",
    "broker",
    "llama-server",
    "model"
  ]) {
    if (!values[name]) usage(`--${name} is required`);
  }
  return values;
}

async function sha256(filename) {
  const handle = await open(filename, "r");
  const digest = createHash("sha256");
  try {
    for await (const chunk of handle.createReadStream()) digest.update(chunk);
  } finally {
    await handle.close();
  }
  return digest.digest("hex");
}

async function verifyFile(filename, executable = false) {
  await access(filename, executable ? constants.X_OK : constants.R_OK);
  const details = await stat(filename);
  if (!details.isFile() || details.size === 0) {
    throw new Error(`required input is not a non-empty file: ${filename}`);
  }
  return details;
}

async function main() {
  const values = parseArgs(process.argv.slice(2));
  const [
    edge,
    image,
    relay,
    broker,
    llama,
    model
  ] = await Promise.all([
    verifyFile(values.edge),
    verifyFile(values.image),
    verifyFile(values.relay, true),
    verifyFile(values.broker, true),
    verifyFile(values["llama-server"], true),
    verifyFile(values.model)
  ]);

  if (model.size !== expected.modelBytes) {
    throw new Error(
      `Qwen GGUF byte length mismatch: ${model.size} != `
      + expected.modelBytes
    );
  }
  const [llamaSha256, modelSha256] = await Promise.all([
    sha256(values["llama-server"]),
    sha256(values.model)
  ]);
  if (llamaSha256 !== expected.llamaServerSha256) {
    throw new Error("pinned llama.cpp binary SHA-256 mismatch");
  }
  if (modelSha256 !== expected.modelSha256) {
    throw new Error("pinned Qwen GGUF SHA-256 mismatch");
  }

  process.stdout.write(`${JSON.stringify({
    status: "inputs-verified",
    edgeBytes: edge.size,
    imageBytes: image.size,
    relayBytes: relay.size,
    brokerBytes: broker.size,
    llamaServerBytes: llama.size,
    modelBytes: model.size,
    pinnedModelVerified: true
  }, null, 2)}\n`);

  const playwright = path.resolve(
    "node_modules",
    ".bin",
    process.platform === "win32" ? "playwright.cmd" : "playwright"
  );
  await access(playwright, constants.X_OK);
  const child = spawn(playwright, [
    "test",
    "--workers=1",
    "tests/openclaw-self-hosted-agent-turn-browser.spec.ts"
  ], {
    env: {
      ...process.env,
      CLAWSEMBLY_EDGE_WASIX: values.edge,
      CLAWSEMBLY_LLAMA_SERVER: values["llama-server"],
      CLAWSEMBLY_LLAMA_SERVER_SHA256: expected.llamaServerSha256,
      CLAWSEMBLY_NETWORK_RELAY: values.relay,
      CLAWSEMBLY_OPENCLAW_IMAGE: values.image,
      CLAWSEMBLY_OPENCLAW_SELF_HOSTED_AGENT_TURN_PROOF: "1",
      CLAWSEMBLY_OPENCLAW_SELF_HOSTED_AGENT_TURN_TIMEOUT_MS:
        process.env.CLAWSEMBLY_OPENCLAW_SELF_HOSTED_AGENT_TURN_TIMEOUT_MS
        ?? "300000",
      CLAWSEMBLY_PROVIDER_BROKER: values.broker,
      CLAWSEMBLY_SELF_HOSTED_MODEL: values.model,
      CLAWSEMBLY_SELF_HOSTED_MODEL_BYTES: String(model.size)
    },
    stdio: "inherit"
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => {
      if (signal) reject(new Error(`proof terminated by ${signal}`));
      else resolve(exitCode ?? 1);
    });
  });
  process.exitCode = code;
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`
  );
  process.exitCode = 1;
});
