# Deploy the browser kernel to Cloudflare

The production distribution uses one Cloudflare Worker custom domain:

- Workers Static Assets serves the Vite application;
- an R2 binding streams the content-addressed Edge.js WASIX and OpenClaw
  package-image objects; and
- every response preserves the cross-origin isolation required by
  `SharedArrayBuffer`.

The default production hostname is `clawsembly.yhay81.com`. The runtime
objects remain same-origin through the Worker at `/edgejs.wasm` and
`/openclaw.clawfs`. Immutable, versioned forms are also available below
`/runtime/<release>/`.

## Why R2 is required

The proven `v0.1.0-alpha.1` Edge.js artifact is about 68 MB and its complete
OpenClaw image is about 317 MB. Both exceed Cloudflare Workers Static Assets'
25 MiB individual-file limit. The Vite output keeps only the patched Wasmer
runtime and application assets in Static Assets; the two large objects are
stored in R2 under keys containing their SHA-256 digests.

The Worker validates each R2 object's byte length against
`runtime-manifest.json`, exposes its proof-bound SHA-256 through `ETag`,
`Content-Digest`, and `X-Clawsembly-SHA256`, and supports `HEAD`, conditional
GET, and byte ranges. `no-transform` keeps those identity bytes and strong
ETags from being rewritten by intermediary compression. Full immutable
responses are placed in Cloudflare's Cache API.

## Requirements

- Node.js 24.15 or newer in the Node 24 line
- Wrangler authentication for the intended Cloudflare account
- the `edgejs-wasix-self-hosted-proof-inputs` artifact from a successful
  public source-build run
- the final schema-v8 `edgejs-wasix-build-evidence.json` from the same run

The proof-input artifact contains `edgejs.wasm`, `openclaw.clawfs`, and the
exact patched Wasmer SDK proven by that run. Never substitute the registry
`@wasmer/sdk` build for a production deployment.

## Prepare a deployment

```bash
npm ci
npm run cloudflare:prepare -- \
  --proof-inputs /path/to/proof-inputs \
  --evidence /path/to/edgejs-wasix-build-evidence.json \
  --release v0.1.0-alpha.1 \
  --source-commit "$CLAWSEMBLY_SOURCE_COMMIT" \
  --proof-run-url \
  "https://github.com/haya-inc/clawsembly-kernel/actions/runs/$CLAWSEMBLY_PROOF_RUN_ID"
```

Preparation fails unless all browser, Gateway, deterministic agent,
workspace, fresh-browser OPFS, self-hosted Qwen, and revocation gates pass.
It also requires the supplied source commit and public proof-run URL to match
the values embedded by GitHub Actions in the evidence, and requires the
repeat-build Wasmer SDK and repeat-package Edge.js reproducibility gates.
It then:

1. verifies both large files against the final evidence;
2. builds Vite against the proof's patched Wasmer SDK;
3. verifies the bundled Wasmer WebAssembly digest;
4. rejects any Static Asset larger than 25 MiB;
5. extracts the official launcher and package metadata for the lightweight
   entrypoint probe; and
6. writes an ignored `.cloudflare/upload-plan.json`.

Validate the Worker bundle without changing Cloudflare:

```bash
npm run cloudflare:deploy -- --dry-run
```

## Create storage and deploy

Create the production bucket once:

```bash
npm exec wrangler -- r2 bucket create clawsembly-kernel-artifacts
```

Upload the content-addressed objects and deploy the Worker:

```bash
npm run cloudflare:deploy
```

Wrangler's single-object command stops at 300 MiB. The deploy script uploads
larger proof artifacts in equal 64 MiB parts through a capability-protected,
temporary Worker with a direct R2 binding. It generates a fresh upload
capability, removes its local secret file, and deletes that temporary Worker
before deploying the public service. No persistent S3 access key is required.

`wrangler.jsonc` declares `clawsembly.yhay81.com` as a custom domain. Wrangler
creates or updates the required DNS record in the Cloudflare-managed
`yhay81.com` zone.

Re-running the deploy is safe: the runtime paths are content-addressed and the
application manifest remains bound to one public proof.

## Verify production

```bash
npm run cloudflare:verify
```

The verifier checks:

- the Worker health response;
- COOP, COEP, CORP, and content-type hardening;
- deployed manifest identity;
- both aliases and versioned object paths;
- byte lengths, SHA-256 headers, ETags, and ranges;
- a live cross-origin-isolated SQLite/OPFS browser check; and
- a live Chromium execution of the unmodified OpenClaw version path from the
  complete R2 package image.

Use `--skip-browser` only for a quick transport check.

## Model and network boundary

Cloudflare distribution hosts the browser kernel and its immutable package
inputs. It does not turn the Linux relay, capability broker, `llama.cpp`, or
Qwen GGUF into Worker processes.

For an actual remote agent turn, deploy the relay and broker on a controlled
host and expose only their capability-scoped WebSocket/HTTP endpoints, or
implement equivalent Worker/Durable Object services. The provider credential
and model service must remain outside the browser. Static deployment alone
must not be described as a hosted self-model service.
