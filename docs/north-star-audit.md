# North Star completion audit

This document maps every binding criterion in
[`NORTH_STAR.md`](../NORTH_STAR.md) to an executable proof. “Implemented” is
not “complete”: a new claim moves to **public pass** only after the
source-build workflow publishes version-bound evidence from the committed
source.

## Current audit

| # | Definition-of-done criterion | State on this branch | Reproducible proof |
| --- | --- | --- | --- |
| 1 | Fetch and verify one exact official OpenClaw artifact | Public pass | npm SHA-512 contract, archive metadata, launcher/package/entrypoint SHA-256 evidence |
| 2 | Install the unmodified artifact and required dependency graph/effects | Public pass | complete shrinkwrap image plus in-browser root lifecycle and `protobufjs` postinstall proof |
| 3 | Supply every runtime behavior reached by the tested release | Public pass for the demonstrated path | source-built Node compatibility profile, compiled SQLite, processes, Workers, nested Wasm, loopback and explicit egress; unused native `tree-sitter-bash` is explicitly denied by OpenClaw policy |
| 4 | Start the real Gateway and pass readiness/health | Public pass | unmodified official entrypoint, readiness marker, authenticated official health RPC |
| 5 | Authenticate a real client and complete a real model-backed agent turn | Public pass; revocation rerun pending | a distinct official OpenClaw CLI guest authenticates with the Gateway token, submits `agent`, and receives the strict Qwen assistant result through the unmodified Gateway |
| 6 | Preserve relevant state across Worker, reload, and fresh browser session | Public pass; workspace extension rerun pending | generation-addressed OPFS state is reopened after browser-process restart; the new tool proof commits an OpenClaw-written workspace and restores it into a fresh guest Directory |
| 7 | Keep credentials/ambient authority outside the guest and use least-privilege revocable capabilities | Implemented; public rerun pending | exact-destination relay; exact-endpoint/model broker; body, concurrency, request-count and TTL limits; distinct host-only revocation followed by HTTP 403 for the old guest token |
| 8 | Publish independently reproducible, version-bound evidence | Pending this branch's public run | the source-build workflow rebuilds every mandatory runtime component and binds all browser, workspace, model, capability and revocation evidence into one artifact |

The North Star remains incomplete until the new public source-build run passes
criteria 5–8 and its immutable run URL is recorded here.

## “Pair a real client” means authenticated client establishment

OpenClaw has two different concepts that should not be conflated:

1. an official CLI client opening an authenticated Gateway WebSocket and
   issuing Gateway RPCs; and
2. OpenClaw device pairing for node/control-UI device identities.

The demonstrated agent path is the first class. The official `openclaw agent`
and `openclaw gateway call` clients require the configured Gateway token,
establish the WebSocket, receive Gateway acceptance, and issue the real
`health`/`agent` RPC. They do not create a pending device-pair record, because
device pairing is not the authentication flow used by that client class.

For this repository, criterion 5 requires a distinct, unmodified official
client process and successful Gateway authentication. It does not require
manufacturing an unrelated device-pair record. If a future proof uses a node
or control-UI client class, that class must complete its native device-pairing
flow.

## Workspace tool-turn contract

The deterministic model fixture is authority-free; it only supplies
OpenAI-compatible `tool_calls`. The unmodified OpenClaw runtime must:

1. invoke `write` on `clawsembly-proof.txt` inside its configured workspace;
2. invoke `read` and return the persisted content to the next model request;
3. invoke `write` once on `/openclaw/.clawsembly-outside.txt` and receive the
   workspace-only policy denial;
4. return the strict final assistant marker;
5. leave no outside file;
6. commit the workspace subtree to OPFS; and
7. restore the file, with matching content, from a verified manifest and
   per-file SHA-256 into a new Wasmer `Directory`.

This complements, rather than weakens, the pinned self-hosted Qwen proof. The
Qwen proof establishes the real local model and credential boundary; the
deterministic tool fixture makes the multi-step tool protocol reproducible and
auditable.

## Host resource boundary

The network relay now defaults to four concurrent WebSocket guests and 2 MiB
WebSocket frames. Both limits are bounded command-line settings. When all
slots are occupied, the relay rejects the new connection before allocating a
virtual-network driver.

The model broker independently enforces one concurrent request, bounded
request/response bodies, a bounded request budget, a short capability TTL, and
host-only revocation. These host controls do not trust OpenClaw configuration
or model behavior.
