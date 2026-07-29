# BYOK onboarding

Clawsembly's public onboarding starts with a user-owned model credential and
turns it into a narrower capability for the browser-local OpenClaw guest.

The first implementation supports OpenAI and OpenRouter's OpenAI-compatible
chat-completions endpoints. It deliberately does not accept an arbitrary
upstream URL because doing so would turn the public Worker into an SSRF proxy.

## Boundary

```text
browser form
  -> HTTPS
Cloudflare Worker
  -> one unique Durable Object
     - exact provider
     - exact model
     - 30-minute TTL
     - 64-request budget
     - guest-token digest
     - separate revocation-token digest
     - user provider credential
  -> fixed provider HTTPS endpoint

OpenClaw guest
  -> opaque guest token only
```

The browser clears the API-key field as soon as issuance completes. It does
not write the provider key, guest capability, or revocation capability to a
URL, `localStorage`, `sessionStorage`, OPFS, logs, or downloadable evidence.
Only the opaque guest capability is staged in page memory for a one-time
runtime handoff. The revocation capability stays in the onboarding module's
private page memory.

The Durable Object stores the provider credential until the capability is
revoked or its alarm fires at expiry. Cloudflare therefore participates in
the secret boundary: this is not an end-to-end browser-to-provider design.
The provider credential never enters Edge.js, WASIX, OpenClaw, its workspace,
or its persisted auth profile.

Revocation overwrites the stored provider credential with `null` before
returning success. Expiry deletes the whole Durable Object session record.

## Public API

Issue a capability from the same-origin onboarding page:

```http
POST /api/byok/capabilities
Content-Type: application/json

{
  "provider": "openai",
  "model": "gpt-5.6",
  "apiKey": "..."
}
```

The response contains an opaque guest token, a separate browser-held admin
token, the fixed OpenAI-compatible base URL, expiry, and request budget.

OpenClaw is configured as a custom OpenAI-compatible provider:

```text
provider id: clawsembly-byok
base URL:    https://clawsembly.yhay81.com/api/byok/v1
API key:     <opaque guest capability>
model:       <the exact model selected at issuance>
```

The broker rejects a different model, an invalid capability, a revoked or
expired capability, and requests past the fixed budget before contacting the
provider.

Revoke from the same browser page:

```http
POST /api/byok/capabilities/revoke
Authorization: Bearer <admin capability>
```

## OpenClaw wizard integration

The pinned official OpenClaw release exposes `wizard.start`, `wizard.next`,
`wizard.cancel`, and `wizard.status`. The product path must render those steps
instead of copying their provider and workspace logic.

When the official wizard reaches a sensitive provider-key step, the
Clawsembly host performs capability issuance and supplies the resulting
custom-provider values to the guest. The real provider key is never submitted
as a wizard answer. `src/byok-capability-handoff.ts` is the one-shot,
memory-only boundary for that runtime integration.

The current page proves issuance, direct provider verification, non-persistence
in browser storage, one-shot handoff, an actual unmodified OpenClaw agent turn,
and revocation.

The OpenClaw guest connects only to a browser-local HTTP server on
`127.0.0.1:18794`. That tiny Edge.js process writes the bounded request to a
shared capability directory. The browser host validates the opaque token and
exact model, forwards the bytes to the same-origin Cloudflare broker with
`fetch`, and writes the response back to the mailbox. The guest has no ambient
external network capability, and the public path no longer needs the native
virtual-net WebSocket relay.

Rendering every remaining workspace, channel, and skill choice through the
official Gateway wizard RPC is the next product integration. The BYOK
provider secret step is intentionally handled before that wizard so the real
credential never becomes a wizard answer or auth-profile value.
