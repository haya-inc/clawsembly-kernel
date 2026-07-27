# Architecture

The architecture serves the repository's [North Star](../NORTH_STAR.md).
Implementation components remain replaceable until the complete, unmodified
OpenClaw path is proven.

## Decision

Clawsembly Kernel is a clean-room browser execution substrate. It does not
implement the existing Clawsembly `BrowserRuntime` contract and does not import
the BrowserPod adapter. Compatibility is derived from the behavior of the
unmodified OpenClaw artifact and from browser platform constraints.

The first personality surface is `node:sqlite`:

```text
OpenClaw require("node:sqlite")
  -> Node core-module personality
  -> synchronous DatabaseSync / StatementSync adapter
  -> official SQLite Wasm
  -> browser: OPFS SAH-pool VFS
  -> Edge.js: nested POSIX/MEMFS plus capability-scoped atomic export
```

In the browser path, the runtime and SQLite execute in one dedicated Worker.
After asynchronous kernel initialization, database operations remain
synchronous from the Node personality's point of view.

## Milestone 0 boundary

Implemented:

- artifact integrity verification and deterministic contract generation
- the exact state schema from the pinned official OpenClaw artifact
- `DatabaseSync` construction for memory and OPFS paths
- `exec()`, `prepare()`, and `close()`
- `StatementSync.get()`, `all()`, `run()`, `iterate()`, and `columns()`
- positional and named bindings
- OpenClaw's busy timeout, WAL, autocheckpoint, `synchronous=NORMAL`, and
  foreign-key pragmas
- `BEGIN IMMEDIATE`, nested savepoint rollback/release, and WAL checkpoint
- bound `ATTACH DATABASE ?` and `VACUUM INTO ?`, including snapshot validation
- OPFS persistence across fresh Worker generations

Deliberately unavailable:

- native extension loading
- `sqlite-vec`
- complete OpenClaw backup archive and restore orchestration
- multi-tab ownership handoff
- full error-code normalization

## Edge.js personality slice

Edge.js already resolves the public `node:sqlite` builtin name, but its pinned
runtime does not register an `internalBinding("sqlite")`. The kernel installs a
synchronous `module.registerHooks()` load hook before importing OpenClaw. Only
the exact `node:sqlite` specifier is intercepted:

```text
Edge.js bootstrap
  -> initialize official SQLite Wasm inside Edge.js/V8
  -> create capability-scoped DatabaseSync personality
  -> register node:sqlite load hook
  -> import exact OpenClaw state chunk
  -> OpenClaw calls require("node:sqlite")
```

OpenClaw package files are not rewritten. The runner verifies the npm artifact
integrity and the state-chunk SHA-256 before executing it.

The nested SQLite Wasm instance cannot directly open an Edge.js host path. For
each granted database path, the personality imports existing bytes into a
stable private MEMFS filename. At autocommit boundaries it checkpoints WAL,
serializes the database, and atomically replaces the capability-granted host
file with mode `0600`. A fresh Edge.js process repeats the import and proves
that the OpenClaw-created state survived.

This storage bridge is intentionally single-process and synchronous. It is an
Edge.js personality proof, not the final browser persistence path; the browser
kernel continues to use OPFS directly.

Unsupported behavior throws instead of silently degrading.

## Browser Node runtime lane

The browser runtime is source-built from pinned upstream commits:

```text
Chromium Worker
  -> patched Wasmer JS (browser-native async compilation)
  -> WASIX scheduler (module bytes + pending-job Worker ownership)
  -> self-contained Edge.js WASIX
  -> embedded QuickJS N-API provider
  -> Node-compatible OpenClaw process
```

The first Edge.js WASIX experiment used its imported N-API provider. It crossed
browser validation, compilation, and WASIX Worker scheduling, then failed
correctly at the missing `napi` and `napi_extension_wasmer_v0` host namespaces.
Those namespaces are supplied by native Wasmer's experimental N-API runtime,
not by Wasmer JS.

Edge.js also ships an embedded QuickJS provider and a dedicated WASIX build
whose own build check rejects unresolved N-API imports. Clawsembly uses that
self-contained provider as the primary browser path. This avoids making a
browser-specific reimplementation of Wasmer's native V8 bridge part of the
kernel. A future browser-engine N-API bridge can remain an optimization without
defining the correctness boundary.

### Compiled SQLite personality

The browser Edge.js build no longer depends on nested JavaScript WebAssembly
for its startup-critical SQLite surface:

```text
OpenClaw require("node:sqlite")
  -> Edge.js lib/sqlite.js
  -> internalBinding("sqlite")
  -> portable N-API DatabaseSync / StatementSync binding
  -> pinned SQLite 3.53.4 amalgamation compiled into Edge.js WASIX
  -> capability-mounted WASIX directory
```

The amalgamation archive is fetched directly from SQLite, verified by byte
length, SHA-256, and the upstream-published SHA3-256, then compiled with
extension loading and double-quoted string literals disabled. No host SQLite
library is accepted. SQLite's serialized thread-safe mode remains enabled
because OpenClaw may use Worker-backed paths. The native QuickJS build proves
the reached OpenClaw surface and retains Node's normal SQLite locking mode.
The single-owner WASIX build applies `locking_mode=EXCLUSIVE` before the first
guest statement because Wasmer's mounted virtual filesystem does not provide
SQLite's normal cross-process shared-memory locking. The browser build must
additionally prove WAL database bytes survive
one Edge.js process and can be reopened read-only by another process sharing
the same mounted directory.

The mounted Wasmer JS directory remains a process-local capability object while
OpenClaw runs. The kernel now commits its mutable state subtree to a
generation-addressed OPFS store. A manifest records every directory, file
length, and file SHA-256; its hash is committed through `HEAD.json` only after
the whole generation is durable. Recovery creates a new Wasmer `Directory`,
verifies the manifest and every payload file, and mounts no ambient host path.
The browser proof fully closes Chromium between commit and recovery, then a new
Edge.js process reopens OpenClaw's installed-plugin SQLite registry without
re-running lifecycle scripts. A second clean restored directory starts the
unmodified Gateway and completes the official authenticated health RPC. See
[the OPFS directory store](opfs-directory-store.md).

### Complete package image

The official OpenClaw artifact publishes a lockfile with hundreds of runtime
archives. The kernel derives a contract from that exact shrinkwrap, verifies
each archive's SRI, validates archive paths and package identities, and writes
a deterministic `ClawsemblyFS` image. The browser verifies and mounts that
complete image at `/openclaw`; OpenClaw files remain byte-identical.

Required lifecycle scripts are recorded with their exact package identities
and commands. The browser kernel executes the exact root pre/postinstall and
`protobufjs` scripts against a shared capability directory. The root
postinstall leaves the clean package files unchanged, creates the SQLite-backed
installed plugin index, and a separate Edge.js process verifies all 33 records.
The Google hook is a literal no-op. OpenClaw's own `allowBuilds` policy disables
the `tree-sitter-bash` native build, and its reached command-explainer path uses
the validated published Wasm grammar instead. This is a version-bound install
contract, not permission to run arbitrary dependency scripts.

Edge.js's QuickJS `globalThis.WebAssembly` surface is now backed by the
MIT/Apache-2.0 `wasmi_c_api_impl` crate, compiled for
`wasm32-unknown-unknown` and statically linked into the WASIX guest. The
adapter implements Edge.js's existing standard Wasm C API integration without
importing native Wasmer's `wasm_c_api_v0` namespace. Nested modules receive no
ambient filesystem or network authority; JavaScript imports remain their only
explicit host interface. Chromium proves a guest-created module compiling,
instantiating, and exporting the value `42`.

QuickJS is ref-counted and releases an otherwise unrooted `WeakRef` target
immediately, while ECMAScript keeps a target observed by `WeakRef` alive until
the end of the current job. Undici creates a `Response`, wraps it in
`WeakRef`, and immediately dereferences it before resolving `fetch()`. The
Edge.js compatibility patch holds constructor and successful `deref()` targets
through the current microtask job, then clears the temporary roots. A browser
regression probe verifies an unrooted target can be dereferenced in the
constructing job; the full OpenClaw agent test exercises the same contract
through Undici.

The Wasmer JS patch is still required. Stock `@wasmer/sdk@0.10.0` validates a
large byte buffer through its older compiler path, while passing only an
already-compiled `WebAssembly.Module` loses the original bytes required by
WASIX child Workers. The kernel compiles asynchronously with Chromium, passes
`{ module, bytes }`, and preserves both across scheduler messages.

The scheduler also reserves a Worker until an asynchronous job's Future
completes. Stock scheduling marks the Worker reusable as soon as an async
payload launches. A WASIX sleep therefore leaves a pending JavaScript timer on
that Worker, which can then receive a synchronous WASM process that blocks the
timer's event loop. Under concurrent Gateway/client execution this starves the
sleeping process even though its TCP data is already readable. The audited
patch keeps the Worker busy through Future completion; the throttled browser
loopback test is the regression proof.

The pinned `wasmer-wasix@0.601.0` also promotes a successful `Exit(0)` returned
by a spawned, non-main WASM thread into `WasiProcess::terminate(0)`. Edge.js's
WASIX libc thread trampoline can take that path after routine background work,
which previously ended a live Gateway or client with code 0 and no Node
shutdown event. The audited dependency patch keeps successful spawned-thread
completion local while preserving process-wide propagation for nonzero exits.
Three consecutive official Gateway health proofs pass with this rule; the
preceding diagnostic build reproduced the faulty child-thread termination path
twice with a unique exit code.

The pinned Wasmer JS source also constructs a configured `WasiEnvBuilder` but
then executes a different, unconfigured `WasiRunner`. That loses command-line
arguments, environment variables, stdio pipes, the current directory, and
mounted directories. The audited patch applies those options directly to the
runner that calls `run_wasm`; this is a compatibility and capability fix, not a
success-looking shim.

### Node event-loop integration

Edge.js originally entered `uv_run(UV_RUN_DEFAULT)` while its Node-style
keep-alive loop was active. V8 foreground tasks and dynamic-import completion
are not necessarily represented by a live libuv handle, so that blocking turn
can sleep while runnable embedder work is waiting. The audited browser patch
uses bounded `UV_RUN_NOWAIT` turns, drains platform tasks and microtasks, and
then yields for one millisecond. Browser tests prove that a refed timer keeps
the process alive, while the full Gateway proof exercises large dynamic imports
and concurrent Gateway/client processes.

The one-millisecond polling yield is a correctness-first integration point,
not the final efficiency design. A browser-native wake bridge may replace it
once it preserves the same Node lifecycle behavior without starving embedder
tasks.

### Browser-local loopback and capability egress

The runtime now contains a browser-local virtual network namespace rather than
delegating OpenClaw execution to a remote machine. The patched Wasmer JS
runtime owns a listener registry scoped to one explicit `Runtime` object. It
permits loopback listen/connect, rejects unsupported external routes with
`PermissionDenied`, reports duplicate listeners and refused connections
explicitly, and removes a listener when the owning socket is dropped.

WASIX completes an in-namespace virtual `connect(2)` synchronously. Edge.js's
libuv patch feeds that successful completion back through the ordinary libuv
I/O queue so Node's existing `net.connect` callback runs without modifying
OpenClaw or Node JavaScript.

The browser proof creates two separate Edge.js guest processes under one
runtime. The server listens on `127.0.0.1:18790`; the client connects,
sends `ping`, receives `pong`, and both processes close cleanly. A third guest
attempts an external connection and receives `EPERM`, proving that loopback
support did not introduce ambient egress. This completes the kernel-level
loopback sub-gate, including:

- real `127.0.0.1` listen/connect semantics;
- a shared runtime-scoped namespace across separate guest processes;
- explicit listen, connect, listener-lifetime, and denied-egress behavior; and
- ordinary Node `net` callback completion over synchronous WASIX virtual TCP.

External TCP is a separate, optional capability on that same runtime object.
Without `networkEgress`, every non-loopback route still fails with
`PermissionDenied`. When granted, the browser accepts only an absolute relay
`ws:` URL on loopback or a `wss:` URL elsewhere, a capability token, and an
allowlist of exact DNS names and ports. Wildcards, numeric external IPs,
unlisted ports, duplicate grants, and private or special-use addresses are
denied by default. A private-network grant is explicit and exists primarily so
the deterministic test fixture can remain local.

The relay in `relay/` is MIT-licensed, self-hostable Rust. It authenticates the
capability token with a constant-time comparison in
`Sec-WebSocket-Protocol`, so credentials do not enter the relay URL. It exposes
only DNS resolution and outbound TCP through `virtual-net`; it provides no
remote shell, filesystem, process execution, UDP, inbound listener, or remote
operating system. The relay independently enforces the same DNS-name, port,
and private-address policy, making a compromised guest insufficient to widen
the grant.

The grant is deliberately described as a DNS-derived TCP endpoint capability.
At the TCP layer, multiple DNS names can share one IP address; HTTPS authority
and server identity therefore remain enforced by the guest's normal TLS/SNI
and certificate validation. A future hostile-guest use case requiring
isolation between virtual hosts on one shared IP would need a name-preserving
TLS or HTTP relay rather than claiming that property from raw TCP.

Node normally asks `getaddrinfo` for `AI_ADDRCONFIG`. The WASIX musl
implementation probes address-family availability with UDP sockets, but this
kernel intentionally grants DNS and TCP without UDP. The Edge.js/libuv patch
clears only that redundant flag on WASI and still invokes the ordinary WASIX
resolver. Browser evidence therefore exercises an unmodified
`net.createConnection({host, port})`, not a custom JavaScript lookup shim.

Two transport adapters close upstream lifecycle gaps. `virtual-net@0.601.0`
does not forward a remote TCP EOF frame, so the audited dependency patch
forwards an empty receive response. Its remote client also reports writable
readiness continuously after connection; the capability socket emits the
single initial completion required by libuv and waits for real backpressure
before signaling another writable event.

The same namespace now carries the real OpenClaw protocol. The
single source-built compatibility artifact starts the exact unmodified
`openclaw@2026.7.1-2` Gateway in normal local mode. After the Gateway emits its
own readiness markers, a second Edge.js guest runs the official
`gateway call health` CLI, authenticates with a capability-scoped token, and
receives a healthy JSON response over `ws://127.0.0.1:18789`. Gateway and
client mount byte-identical package images into distinct filesystem
instances. The response proves the two official migrated startup plugins
(`memory-core` and `ollama`), no plugin errors, active configuration reload,
and the default `main` agent.

The agent-turn proof then runs the official `openclaw agent` CLI in that
second guest. The unmodified Gateway builds the real model request, sends it
through Undici and the explicitly granted outbound-TCP capability, consumes a
streaming OpenAI-compatible response from a deterministic local fixture, and
returns the assistant marker to the CLI. The fixture records the request
method, path, authorization, model, streaming flag, message roles, and
instruction without receiving relay credentials or any wider guest authority.

The Edge.js implementation baseline and compatibility claim remain distinct.
`edgejs --version` reports the source identity `v24.13.2-pre`, while
`process.version` and `process.versions.node` report the contract-gated
compatibility version `v24.15.0` and `24.15.0`. That value is compiled from
audited source, not substituted into a finished Wasm binary. The profile is
scoped to the pinned unmodified OpenClaw workload and does not claim full Node
test-suite conformance or that Edge.js is an official Node binary.

OpenClaw introduced the Node 24.15 floor to reject embedded SQLite releases
affected by the WAL-reset corruption bug. This kernel queries the loaded SQLite
library and proves 3.53.4, above OpenClaw's 3.51.3 safe floor, before the
unmodified Gateway uses state. The required install lifecycle effects execute
on the same filesystem before Gateway startup. The deterministic fixture proves
the real OpenClaw agent code path and capability transport, but not live model
inference or Internet TLS. Durable recovery is separately proven through a
complete browser restart; a live authorized TLS model-provider exchange remains
the final end-to-end gate.

Model-provider traffic can use this separately authorized self-hostable
transport, but it cannot substitute for local Gateway loopback. Browser-local
listeners always win over an egress resolution, unsupported routes fail
explicitly, and a requested loopback bind is never turned into a wildcard host
bind.

The Edge.js compiler sysroot is pinned to wasix-libc `v2025-12-10.1`, the last
release using the `proc_exec3`/`proc_spawn2` ABI implemented by Wasmer JS
0.10's WASIX 6.1 runtime. Newer sysroots require
`proc_exit2`/`proc_exec4`/`proc_spawn3`; silently stubbing those process
semantics would violate the kernel's compatibility and capability boundaries.
CI installs only that release's legacy-EH sysroot asset and verifies its pinned
SHA-256, avoiding the toolchain's unrelated newer `exnref` asset set.

The
[public browser build workflow](https://github.com/haya-inc/clawsembly-kernel/actions/workflows/edgejs-wasix-build.yml)
builds the source-pinned runtime and executes the complete lane. Chromium
reports three arguments (`edgejs`, `-e`, and the evidence program), captures
the runtime marker, and observes a clean exit. A second process proves that
`process.exit(7)` unwinds immediately: stdout is exactly `before-exit\n`, the
following statement is not executed, and WASIX reports code 7. A third process
executes the exact official `openclaw.mjs` launcher and proves that it accepts
the source-built compatibility profile without modifying the launcher.
Additional guests prove synchronous SQLite persistence and the browser-local
loopback exchange described above. The evidence pins:

- Edge `0.0.0-554eb9b`
- Edge.js source baseline `v24.13.2-pre`
- OpenClaw-scoped Node compatibility version `24.15.0`
- V8 `0.0.0-node.0`
- the Edge.js WASIX and source-built Wasmer JS SHA-256 digests
- OpenClaw `2026.7.1-2` npm integrity
  `sha512-ycF3yPcbjN6bUPeaUx6Mh6vze1hQWoD3CT/wWcmD7a8xaHHHRUaAlaq+lFxMHf1ssEgODVAwjlzYqp2twkYZ7g==`

The same workflow extends the lane through Gateway readiness, authenticated
client RPC, the deterministic agent turn, and fresh-browser OPFS recovery. It
does not yet satisfy the complete North Star because the provider proof is not
a live authorized TLS exchange.

## OPFS WAL precondition

The official SQLite Wasm build requires `locking_mode=EXCLUSIVE` before the
first database operation in order to activate WAL on OPFS. The OPFS
`DatabaseSync` personality applies that storage precondition in its constructor
before the unmodified OpenClaw code can issue SQL. Native Node remains in
`locking_mode=NORMAL`.

This difference is explicit in the browser evidence and covered by the
differential test. It does not rewrite or skip OpenClaw's own WAL configuration.
See SQLite's
[WAL Mode with OPFS](https://sqlite.org/wasm/doc/trunk/persistence.md#wal_mode_with_opfs)
documentation.

## Ownership

One runtime Worker owns an OPFS database at a time. Later browser tabs will
connect to that owner rather than opening competing SQLite handles. This
matches OPFS synchronous access-handle exclusivity and gives the kernel one
place to enforce capabilities, snapshots, and resource limits.

The Edge.js personality independently requires one or more
`allowedPathRoots`. `:memory:` is always available, while any file path escaping
those roots throws `ERR_CLAWSEMBLY_CAPABILITY_DENIED`. Native SQLite extension
loading is unavailable rather than silently bypassing the boundary.
