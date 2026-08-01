# Official Wizard and model credential boundary

Clawsembly runs the pinned, unmodified OpenClaw Gateway in the browser and
renders its real `wizard.start`, `wizard.next`, `wizard.status`, and
`wizard.cancel` steps. It does not maintain a second copy of OpenClaw's setup
flow.

The one intentional interception point is model authentication. OpenAI API
keys, OpenRouter API keys, and OpenAI ChatGPT device OAuth are converted into
a narrower, expiring operation capability before OpenClaw receives anything.

## Boundary

```text
official OpenClaw Wizard
  -> reaches a supported model-auth method
Clawsembly browser host
  -> API key, or OpenAI Device Code approval
Cloudflare Worker + one unique Durable Object
  -> exact provider
  -> exact model
  -> exact API family (Chat Completions or Responses)
  -> 30-minute TTL
  -> 64-request budget
  -> separate guest, polling, and revocation token digests
  -> API key, or OAuth access + refresh token
fixed provider HTTPS endpoint

OpenClaw guest
  -> opaque guest capability only
  -> browser-local 127.0.0.1:18794
  -> capability-directory mailbox
  -> same-origin Worker fetch by the browser host
```

The browser never writes provider keys, OAuth tokens, device authorization
identifiers, guest capabilities, or revocation capabilities to a URL,
`localStorage`, `sessionStorage`, OPFS, logs, or downloadable evidence.

## First and later launches

Before the Gateway starts or any model capability is attached, Clawsembly
commits the verified OpenClaw install-state subtree to a generation-addressed
OPFS snapshot. The store ID is derived from both the Edge.js and OpenClaw image
SHA-256 identities, so a runtime upgrade automatically selects a new cache.

A later browser process restores the snapshot, verifies the manifest and every
file hash, and skips the package lifecycle scripts. A missing, corrupt, or
incompatible snapshot falls back to a new Directory and a normal cold boot.
Provider credentials remain outside this snapshot. Wizard session state is not
persisted; while an owner is live, only its current public Wizard result is held
ephemerally by the tab coordinator.

For onboarding, a same-origin `SharedWorker` elects one cross-origin-isolated
runtime iframe as the live Gateway owner. Later tabs reuse that exact Gateway
and persistent official client through routed `MessagePort` requests instead
of booting another 385 MB runtime. The coordinator mirrors the current official
Wizard result, so `wizard.start` in a follower joins the existing session rather
than attempting a second session that OpenClaw rejects. It never runs Wasmer or
holds provider credentials.

When the owner tab closes, the coordinator promotes a follower, which restores
the verified OPFS snapshot and starts a replacement Gateway. An origin-wide Web
Lock remains the fallback for browsers without `SharedWorker` and for proof
pages that intentionally run an independent runtime.

The Durable Object stores the provider credential until revocation or alarm
expiry. Cloudflare therefore participates in the secret boundary; this is not
an end-to-end browser-to-provider custody design. The provider credential
never enters Edge.js, WASIX, OpenClaw, its workspace, or an OpenClaw auth
profile.

Revocation clears API keys, OAuth access tokens, OAuth refresh tokens, and any
pending device authorization state before returning. Expiry deletes the whole
Durable Object session record.

## API-key capability

Issue from the same-origin onboarding page:

```http
POST /api/byok/capabilities
Content-Type: application/json

{
  "provider": "openai",
  "model": "gpt-5.6",
  "apiKey": "..."
}
```

Supported API-key providers are fixed to OpenAI and OpenRouter. Arbitrary
upstream URLs are rejected so the Worker cannot become an SSRF proxy.

The returned capability is restricted to:

```text
POST /api/byok/v1/chat/completions
provider: <issued provider>
model:    <issued model>
```

OpenClaw receives the capability through a custom
`openai-completions` provider at `http://127.0.0.1:18794/v1`.

## OpenAI ChatGPT device OAuth

Start device authorization:

```http
POST /api/oauth/openai/device/start
Content-Type: application/json

{
  "model": "gpt-5.6-sol"
}
```

The Worker calls OpenAI's device authorization endpoint and returns only the
user code, verification URL, a polling capability, and a separate revocation
capability. The browser opens:

```text
https://auth.openai.com/codex/device
```

Poll after the user approves:

```http
POST /api/oauth/openai/device/poll
Authorization: Bearer <poll capability>
```

The Durable Object exchanges the device authorization code, derives the
ChatGPT account ID from the access-token identity claim, and stores the access
and refresh tokens. Neither token is returned to the browser.

The returned guest capability is restricted to:

```text
POST /api/byok/v1/responses
provider: OpenAI ChatGPT
model:    gpt-5.6-sol
```

OpenClaw uses its official `openai-chatgpt-responses` transport against the
browser-local bridge. The Worker adds the real OAuth authorization and
`ChatGPT-Account-Id` header only on the fixed
`https://chatgpt.com/backend-api/codex/responses` hop. Expiring access tokens
are refreshed inside the Durable Object under serialized concurrency.

## Official Wizard integration

The browser runtime starts:

1. the exact unmodified Gateway;
2. one persistent Edge.js guest importing the official OpenClaw
   `GatewayClient` facade;
3. a bounded mailbox between the page host and that client.

The persistent client is important: starting a new OpenClaw CLI guest for
every Wizard answer adds a full runtime startup to every click. One official
client keeps the Gateway connection alive while the page renders each real
Wizard step.

At `OpenAI auth method` or `OpenRouter auth method`, Clawsembly displays its
credential adapter. After capability issuance it answers that official Wizard
step with `skip`, so no provider secret becomes a Wizard answer or OpenClaw
auth-profile value. When the Wizard completes, the control guest uses the
exact package's public `config/config.js` reader, validator, conflict guard,
and writer against the Gateway's shared state mount. Only the fixed model
provider fields are merged. This avoids returning OpenClaw's large, redacted
`config.get` snapshot across the Wasm structured-clone boundary. The control
guest then rereads and verifies the committed file before reporting success;
only the opaque capability is selected as the model credential. It then asks
the official Gateway for a safe restart with `gateway.restart.request`.
`OPENCLAW_NO_RESPAWN=1` keeps that restart inside the existing browser Wasm
process. The persistent official client reconnects, and Clawsembly reports
success only after `agents.list` exposes the selected primary model.

Any other Wizard step marked `sensitive` currently fails closed instead of
sending a secret into the guest. Adding capability adapters for channel and
service credentials is future work.

## Verification

Automated coverage includes:

- API-key issue, model/path confinement, budget, revocation, and expiry;
- OpenAI device start, poll, token exchange, serialized refresh, account
  identity header, Responses confinement, and revocation;
- Chat Completions and Responses browser-local mailbox paths;
- mocked end-to-end Wizard rendering and credential interception;
- same-origin owner election, current-Wizard mirroring, request routing, and
  follower promotion after the owner closes;
- a full Chromium proof that boots the real Edge.js Wasm, mounts the complete
  OpenClaw image, starts the unmodified Gateway, connects the persistent
  official GatewayClient, calls `wizard.start`, renders the returned
  `OpenClaw setup` step, and commits a fixed-shape capability provider through
  the exact package's public config writer, safely restarts the Gateway in
  process, reconnects, and verifies the active model through `agents.list`;
- a full Chromium multi-tab proof that boots one real Gateway and connects a
  later onboarding tab to its official Wizard without loading a second runtime.
