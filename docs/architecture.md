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
  -> WASIX scheduler (module + original bytes retained across Workers)
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

That mounted directory is currently an in-memory Wasmer JS capability object.
It proves the SQLite and process boundary, but does not yet satisfy the North
Star persistence requirement. The final storage broker must commit the
capability directory to OPFS and recover it in a fresh browser session without
granting ambient filesystem access to the guest.

### Complete package image

The official OpenClaw artifact publishes a lockfile with hundreds of runtime
archives. The kernel derives a contract from that exact shrinkwrap, verifies
each archive's SRI, validates archive paths and package identities, and writes
a deterministic `ClawsemblyFS` image. The browser verifies and mounts that
complete image at `/openclaw`; OpenClaw files remain byte-identical.

Required lifecycle scripts are recorded with their exact package identities
and commands. They are not silently treated as complete: executing or replacing
each required lifecycle effect inside the capability kernel remains an
explicit gate before the package-install requirement is satisfied.

Edge.js's optional QuickJS `globalThis.WebAssembly` implementation is disabled
in this first browser build. That implementation imports native Wasmer's
`wasm_c_api_v0` namespace, which Wasmer JS does not expose. The audited build
rejects that namespace so an apparently self-contained artifact cannot regress
to a hidden native-host dependency. Restoring nested JavaScript WebAssembly
through an OSS browser-native adapter remains an explicit compatibility gate.

The Wasmer JS patch is still required. Stock `@wasmer/sdk@0.10.0` validates a
large byte buffer through its older compiler path, while passing only an
already-compiled `WebAssembly.Module` loses the original bytes required by
WASIX child Workers. The kernel compiles asynchronously with Chromium, passes
`{ module, bytes }`, and preserves both across scheduler messages.

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

### Browser-local virtual networking

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

The same namespace now carries the real OpenClaw protocol. The
diagnostic-only Node-floor artifact starts the exact unmodified
`openclaw@2026.7.1-2` Gateway in normal local mode. After the Gateway emits its
own readiness markers, a second Edge.js guest runs the official
`gateway call health` CLI, authenticates with a capability-scoped token, and
receives a healthy JSON response over `ws://127.0.0.1:18789`. Gateway and
client mount byte-identical package images into distinct filesystem
instances. The response proves eight loaded plugins, no plugin errors, active
configuration reload, and the default `main` agent.

This is a Gateway compatibility milestone, not a Node-version claim. The
artifact differs from the source-built Edge.js Wasm only by two equal-length
embedded version-label substitutions, and its evidence records both hashes
and offsets. Genuine Node 24.15 compatibility, authorized model-provider
egress, a real agent turn, and persistent recovery in a fresh browser session
remain separate gates.

External model-provider traffic may later use a separately authorized
self-hostable transport, but it cannot substitute for local Gateway loopback.
The virtual network must fail unsupported routes explicitly and must never
turn a requested loopback bind into a wildcard host bind.

The Edge.js compiler sysroot is pinned to wasix-libc `v2025-12-10.1`, the last
release using the `proc_exec3`/`proc_spawn2` ABI implemented by Wasmer JS
0.10's WASIX 6.1 runtime. Newer sysroots require
`proc_exit2`/`proc_exec4`/`proc_spawn3`; silently stubbing those process
semantics would violate the kernel's compatibility and capability boundaries.
CI installs only that release's legacy-EH sysroot asset and verifies its pinned
SHA-256, avoiding the toolchain's unrelated newer `exnref` asset set.

The browser lane is publicly proven by
[GitHub Actions run 30203815745](https://github.com/haya-inc/clawsembly-kernel/actions/runs/30203815745).
Chromium reported three arguments (`edgejs`, `-e`, and the evidence program),
captured the runtime marker, and observed a clean exit. A second process proved
that `process.exit(7)` unwinds immediately: stdout is exactly `before-exit\n`,
the following statement is not executed, and WASIX reports code 7. A third
process executes the exact official `openclaw.mjs` launcher and stops at its
honest Node version gate with code 1, empty stdout, and no `dist/entry.js`
fall-through. Additional guests prove synchronous SQLite persistence and the
browser-local loopback exchange described above. The evidence pins:

- Edge `0.0.0-554eb9b`
- Node `24.13.2`
- V8 `0.0.0-node.0`
- Edge.js WASIX SHA-256
  `706af076949e662f3af2c2d57ae5e23b25956bf796377fa84b56bb048be208ae`
- Wasmer JS runtime Wasm SHA-256
  `467cbca59bd647262cd6f7377f6354a36f72f696d959acc60fb79ed52fa2c46d`
- OpenClaw `2026.7.1-2` npm integrity
  `sha512-ycF3yPcbjN6bUPeaUx6Mh6vze1hQWoD3CT/wWcmD7a8xaHHHRUaAlaq+lFxMHf1ssEgODVAwjlzYqp2twkYZ7g==`

That earlier run proves the browser runtime lane. The newer Gateway health
proof extends the lane through readiness and authenticated client RPC, but
still does not satisfy the complete North Star.

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
