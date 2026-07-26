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

The Edge.js compiler sysroot is pinned to wasix-libc `v2025-12-10.1`, the last
release using the `proc_exec3`/`proc_spawn2` ABI implemented by Wasmer JS
0.10's WASIX 6.1 runtime. Newer sysroots require
`proc_exit2`/`proc_exec4`/`proc_spawn3`; silently stubbing those process
semantics would violate the kernel's compatibility and capability boundaries.
CI installs only that release's legacy-EH sysroot asset and verifies its pinned
SHA-256, avoiding the toolchain's unrelated newer `exnref` asset set.

The browser lane is publicly proven by
[GitHub Actions run 30197574607](https://github.com/haya-inc/clawsembly-kernel/actions/runs/30197574607).
Chromium reported three arguments (`edgejs`, `-e`, and the evidence program),
captured the runtime marker, and observed a clean exit. A second process proved
that `process.exit(7)` unwinds immediately: stdout is exactly `before-exit\n`,
the following statement is not executed, and WASIX reports code 7. A third
process executes the exact official `openclaw.mjs` launcher and stops at its
honest Node version gate with code 1, empty stdout, and no `dist/entry.js`
fall-through. The evidence pins:

- Edge `0.0.0-554eb9b`
- Node `24.13.2`
- V8 `0.0.0-node.0`
- Edge.js WASIX SHA-256
  `3ddd8410e20d04572a2079a1805079ed09210d3e5f36b7beb5902b4c94ab482a`
- Wasmer JS runtime Wasm SHA-256
  `e19c6af6d0e7ad228b91b95e7e4d74559787844aaa057ab7f1b0edbdaa11f7ea`
- OpenClaw `2026.7.1-2` npm integrity
  `sha512-ycF3yPcbjN6bUPeaUx6Mh6vze1hQWoD3CT/wWcmD7a8xaHHHRUaAlaq+lFxMHf1ssEgODVAwjlzYqp2twkYZ7g==`

This proves the browser runtime lane, not complete OpenClaw startup.

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
