# Model capability broker

`provider-broker/` keeps model-service authority outside the browser guest.
OpenClaw receives an opaque, revocable operation capability instead of the
credential accepted by the inference server. The broker exposes only:

```text
POST http://127.0.0.1:18794/v1/chat/completions
```

The host selects one exact upstream and one exact model at startup. Neither can
be changed by a guest request.

## Authority boundary

The broker:

- binds only to an IPv4 or IPv6 loopback address;
- compares the opaque bearer capability in constant time;
- accepts only JSON, one configured model, non-empty messages, and streaming
  requests;
- caps request and response bodies at 2 MiB;
- permits one concurrent request and a bounded lifetime request budget;
- discards guest headers other than the validated body semantics;
- replaces the guest capability with the model-service bearer credential only
  in the fixed upstream request;
- disables HTTP redirects and system proxies;
- normally requires HTTPS on port 443, an exact DNS hostname, TLS 1.2 or newer,
  and platform certificate validation;
- permits HTTP only with `--allow-loopback-http-upstream`, an explicit
  nonzero port, and `localhost` or an IP loopback address;
- streams selected response metadata and bytes without forwarding cookies or
  model-service authority headers; and
- records request IDs, status, timing, and model, but never prompts,
  capabilities, or credentials.

The browser kernel grants the guest only the broker's loopback endpoint. The
credential cannot authorize filesystem, process, repository, or arbitrary
network access because it never crosses that boundary.

## Self-hosted proof

The public proof uses:

- llama.cpp `b9637`, source commit
  `aedb2a5e9ca3d4064148bbb919e0ddc0c1b70ab3`, MIT;
- the Ubuntu x64 distribution archive SHA-256
  `a50ee14f021a9d8e92e30f622f7e3be1318ee1125bb9a9ba8d2025388df48743`;
- Qwen2.5 0.5B Instruct Q4_K_M, Apache-2.0, revision
  `d78c9c2baefc6237025b685bb0d6db90288ef3d6`;
- GGUF SHA-256
  `74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db`;
  and
- a full 32,768-token model context and a one-request broker budget.

Run the broker after starting llama.cpp on `127.0.0.1:18795`:

```bash
cargo build --locked --release \
  --manifest-path provider-broker/Cargo.toml

CLAWSEMBLY_PROVIDER_BROKER_TOKEN=replace-with-operation-capability \
CLAWSEMBLY_PROVIDER_API_KEY=replace-with-model-service-key \
  provider-broker/target/release/clawsembly-provider-broker \
  --upstream http://127.0.0.1:18795/v1/chat/completions \
  --allow-loopback-http-upstream \
  --model qwen2.5-0.5b-instruct \
  --max-requests 1
```

`--upstream` is required. A non-loopback listener, an ambient HTTP upstream,
an IP-literal HTTPS upstream, a redirectable URL shape, a malformed capability,
or an unbounded request budget is rejected before the server starts.

## Proof contract

The completion proof starts the source-built broker with the llama.cpp API key
only in the broker process, configures unmodified OpenClaw with only the opaque
operation capability, and observes:

1. one accepted broker request for the configured model;
2. one HTTP 200 streaming response from the checksum-pinned llama.cpp process;
3. the requested assistant marker returned through the unmodified Gateway and
   official CLI;
4. no model-service credential in the browser URL, guest evidence, process
   logs, or uploaded artifacts; and
5. exact model, endpoint, concurrency, request-size, response-size, and request
   count bounds independent of OpenClaw.

The assistant marker is not searched recursively. OpenClaw retains the input
under metadata such as `finalPromptText`, so recursive matching can falsely
accept a timeout that merely echoes the requested marker. The
`strict-assistant-payload-v1` validator requires:

- top-level `status: "ok"` and `summary: "completed"`;
- `aborted: false`, `replayInvalid: false`, and `stopReason: "stop"`;
- a successful assistant-stage execution with no fallback;
- the exact marker in `result.payloads[].text`; and
- the same exact text in both final-assistant fields.

A unit regression test rejects prompt-only echoes, timeouts, aborted results,
fallbacks, and marker substrings. The final public artifact-binding step
rechecks the same fields with `jq` before publishing the proof.
