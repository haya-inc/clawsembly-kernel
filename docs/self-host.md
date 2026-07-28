# Self-host the complete OpenClaw proof

This path runs the exact unmodified OpenClaw release in Chromium using the
source-built Clawsembly runtime. The model provider is a pinned local
`llama.cpp` process with a pinned Qwen GGUF. No remote VM, container service,
or proprietary execution substrate hosts OpenClaw.

## What stays where

| Boundary | Browser guest | Host loopback |
| --- | --- | --- |
| OpenClaw package and mutable state | Yes | No |
| Edge.js/WASIX Node personality | Yes | No |
| One-use model operation token | Yes | Broker validates it |
| Provider credential | No | Broker only |
| llama.cpp process and GGUF | No | Yes |
| External AI service | No | No |

The browser receives only two opaque operation capabilities: one for the
exact relay destination and one for the exact broker endpoint/model. The
broker capability has a short TTL, one-request budget, single concurrency,
bounded bodies, and host-only revocation.

## Requirements

- Node.js 24.15 or newer in the Node 24 line
- current Chromium
- Rust 1.97.1 when building the relay and broker locally
- approximately 1.5 GB free for the source-built runtime, package image,
  llama.cpp distribution, Qwen GGUF, and build intermediates

The most reproducible input bundle is the
`edgejs-wasix-browser-compatible` artifact from the public source-build
workflow. It includes:

- `edge-quickjs-wasix-browser-compatible.zip`
- `clawsembly-network-relay`
- `clawsembly-provider-broker`
- version-bound JSON evidence and SHA-256 digests

The OpenClaw package image is intentionally generated from the pinned npm
artifact rather than checked into Git.

## Build the browser package image

```bash
npm ci
npm run package-contract:check
npm pack openclaw@2026.7.1-2 --ignore-scripts --pack-destination /tmp
CLAWSEMBLY_OPENCLAW_ARCHIVE=/tmp/openclaw-2026.7.1-2.tgz \
  npm run package-image:build -- \
    --output /tmp/openclaw.clawfs \
    --evidence /tmp/openclaw-image-evidence.json
```

Use the exact archive filename printed by `npm pack`.

## Acquire the pinned local model

The public workflow is the executable source of truth for download URLs and
digests. The pinned inputs are:

- llama.cpp `b9637`, source commit
  `aedb2a5e9ca3d4064148bbb919e0ddc0c1b70ab3`
- `llama-server` SHA-256
  `77eb1229a117e3034b873a46382bffcecc0f9815bd14e825a0706f8fc0b07564`
- Qwen2.5 0.5B Instruct Q4_K_M, revision
  `d78c9c2baefc6237025b685bb0d6db90288ef3d6`
- GGUF SHA-256
  `74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db`
- GGUF byte length `491400032`

## Run the proof

The wrapper validates every required file and the pinned model digests before
starting the browser test. It generates fresh operation tokens in memory.

```bash
npm run self-host:prove -- \
  --edge /path/to/edgejs.wasm \
  --image /tmp/openclaw.clawfs \
  --relay /path/to/clawsembly-network-relay \
  --broker /path/to/clawsembly-provider-broker \
  --llama-server /path/to/llama-server \
  --model /path/to/qwen2.5-0.5b-instruct-q4_k_m.gguf
```

A passing run writes
`openclaw-self-hosted-agent-turn-browser-evidence.json` under Playwright's
`test-results` directory. The evidence binds:

1. the exact runtime and package image hashes;
2. the official CLI-to-Gateway authenticated connection;
3. the strict assistant response;
4. broker request bounds and credential isolation;
5. post-turn host revocation and rejection of the former guest token.

## Local contract console

`npm run dev` opens the minimal kernel console. Its default action is a fast,
local SQLite/OPFS contract check; it does not pretend to be the full
multi-minute OpenClaw build proof. Use the command above for the full proof.
