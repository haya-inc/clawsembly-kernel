# Provider credential broker

The raw-TCP capability proves that the browser guest can perform ordinary
Node TLS, SNI, certificate validation, and streaming model inference. It does
not by itself satisfy the production secret boundary because an API bearer
token in OpenClaw's in-memory provider configuration is still visible to the
guest.

`provider-broker/` moves the provider credential into a separate,
self-hostable OSS process. OpenClaw receives an opaque, revocable operation
capability instead. The broker accepts only one OpenAI-compatible operation:

```text
POST http://127.0.0.1:18794/v1/chat/completions
```

The host selects one exact HTTPS upstream and one exact model at broker
startup. Neither can be changed by a guest request.

## Authority boundary

The broker:

- binds only to an IPv4 or IPv6 loopback address;
- compares the opaque bearer capability in constant time;
- accepts only JSON, one configured model, non-empty messages, and streaming
  requests;
- caps request and response bodies at 2 MiB;
- permits one concurrent request and a bounded lifetime request budget;
- discards guest headers other than the validated body semantics;
- injects the provider bearer credential only into the fixed upstream request;
- disables HTTP redirects and system proxies;
- requires HTTPS on port 443, an exact DNS hostname, TLS 1.2 or newer, and
  platform certificate validation;
- streams selected response metadata and bytes without forwarding cookies or
  provider-specific authority headers; and
- records request IDs, status, timing, and model, but never prompts,
  capabilities, or provider credentials.

The browser kernel still grants the guest only the broker's loopback endpoint.
The provider credential cannot authorize repository, filesystem, process, or
arbitrary network access because it never crosses that boundary.

## Run

```bash
cargo build --locked --release \
  --manifest-path provider-broker/Cargo.toml

CLAWSEMBLY_PROVIDER_BROKER_TOKEN=replace-with-an-operation-capability \
CLAWSEMBLY_PROVIDER_API_KEY=replace-with-the-provider-secret \
  provider-broker/target/release/clawsembly-provider-broker \
  --upstream https://models.github.ai/inference/chat/completions \
  --model openai/gpt-4o \
  --max-requests 1
```

The default listener is `127.0.0.1:18794`. A non-loopback listener, HTTP or
IP-literal upstream, redirectable URL shape, malformed capability, or
unbounded request budget is rejected before the server starts.

## Proof contract

The completion proof must start this exact source-built broker with the
provider credential only in the broker process, configure unmodified OpenClaw
with only the opaque operation capability, and observe all of the following:

1. one accepted broker request for the configured model;
2. one live HTTPS provider response;
3. the requested assistant marker returned through the unmodified Gateway and
   official CLI;
4. no provider credential in the browser URL, guest evidence, broker logs, or
   uploaded artifacts; and
5. wrong capability, model, endpoint, request budget, and ambient network
   authority denied independently of OpenClaw.
