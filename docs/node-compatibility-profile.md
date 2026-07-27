# OpenClaw-scoped Node compatibility profile

Clawsembly does not distribute an official Node.js binary. It uses Edge.js, an
independently implemented Node-compatible runtime built on QuickJS and WASIX.
The runtime therefore records two different facts:

- `edgejs --version` is the imported implementation baseline:
  `v24.13.2-pre`.
- `process.version` and `process.versions.node` are the workload compatibility
  declaration: `v24.15.0` and `24.15.0`.

The two values are intentionally different and are captured by the browser
evidence. Patch
`patches/edgejs/0008-declare-openclaw-node-24-compatibility.patch` declares
the compatibility version in source. CI no longer creates or executes a
post-build version-mutated Wasm artifact.

## Why OpenClaw requires 24.15.0

OpenClaw commit
`f33ab243cf820e7558562381dbfaa1407bfb39a7` introduced the current Node floors
to reject runtimes whose loaded SQLite library is vulnerable to the upstream
WAL-reset corruption bug. Its runtime check accepts SQLite 3.51.3 or newer, or
the safe 3.44.6 and 3.50.7 backports.

The Clawsembly Edge.js build compiles SQLite 3.53.4 directly into the runtime.
The unmodified OpenClaw code independently opens `node:sqlite`, runs
`SELECT sqlite_version()`, and rejects an unsafe result. Browser proof also
exercises WAL, checkpointing, overlapping logical connections, read-only
enforcement, statement finalization, and a fresh guest-process read.

## Evidence gate

The compatibility profile is accepted only when one source-built Wasm artifact
passes all of these checks:

1. Runtime evidence observes the `v24.13.2-pre` source baseline separately from
   `process.versions.node === "24.15.0"`.
2. The loaded SQLite runtime reports 3.53.4 and passes the cross-process WAL
   contract.
3. The integrity-pinned official `openclaw@2026.7.1-2` launcher accepts the
   runtime without any OpenClaw file mutation.
4. The complete package image matches the recorded package, launcher, entry,
   and shrinkwrap hashes.
5. The unmodified Gateway reaches readiness and a distinct official CLI guest
   completes an authenticated health RPC.
6. The unmodified Gateway completes an agent turn through the explicit outbound
   TCP capability.

The machine-readable definition is
`contracts/edgejs-browser-build.json#nodeCompatibility`. The public workflow
builds the runtime from the pinned Edge.js commit, applies every hash-pinned
patch, and executes the entire evidence gate in Chromium.

## Non-claims

This profile does not claim complete Node 24.15 test-suite conformance, native
addon ABI compatibility, or that the artifact was built from the official Node
24.15 source tree. It establishes sufficient, execution-backed compatibility
for the pinned unmodified OpenClaw Gateway and agent path.

It also does not complete Clawsembly's North Star by itself. The required
install lifecycle effects are now independently proven by the
[install lifecycle contract](openclaw-install-lifecycle.md), and the
[OPFS directory store](opfs-directory-store.md) proves recovery of that state
after a complete browser restart. A live authorized TLS model-provider exchange
remains a separate gate.
