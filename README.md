# Clawsembly Kernel

A clean-room browser execution kernel for running an unmodified OpenClaw
artifact without BrowserPod.

## North Star

Run the official, unmodified OpenClaw artifact completely inside a browser on
an OSS, self-hostable kernel, without a proprietary execution substrate or a
remote operating system. Completion requires reproducible public evidence of:

- persistent OpenClaw state;
- sufficient Node compatibility to start the official entrypoint;
- explicit filesystem, network, process, and secret capability boundaries;
- an OpenClaw Gateway connection; and
- one real agent turn.

Partial compatibility probes are milestones toward that result, not alternate
definitions of success.

This repository starts below Node. Browser capabilities form the kernel;
Node compatibility is a replaceable personality above it. The first vertical
slice derives a synchronous `node:sqlite` contract from a pinned official
OpenClaw artifact, implements it on the official SQLite WebAssembly build and
OPFS, then registers the same capability as a core-module personality inside
Edge.js.

## Milestone 0

The contract probe:

1. downloads the pinned `openclaw@2026.7.1-2` tarball and verifies its npm
   SHA-512 integrity;
2. extracts the exact 39,871-byte state schema and the SQLite behaviors used by
   the artifact;
3. executes its 73 tables and 103 explicit indexes through `DatabaseSync` and
   `StatementSync` compatible classes;
4. exercises OpenClaw's connection pragmas, immediate transaction, nested
   savepoint, and WAL checkpoint behavior;
5. proves bound `ATTACH DATABASE ?` and `VACUUM INTO ?` by reopening the
   generated state snapshot;
6. closes the database and starts a fresh read-only Worker;
7. verifies that the canonical OpenClaw state survived in OPFS;
8. compares the browser evidence with the same contract on native Node
   `node:sqlite`.

No package or source file from the BrowserPod-backed Clawsembly repository is
imported.

## Run

Requirements:

- Node.js 24.15 or newer in the Node 24 line
- a current Chromium browser

```bash
npm install
npm run check
```

For the interactive probe:

```bash
npm run dev
```

To run only the Edge.js/OpenClaw artifact proof:

```bash
npm run test:edgejs
```

That command downloads integrity-pinned Edge.js and OpenClaw archives, extracts
only the OpenClaw dependencies reached by the state-chunk import graph from its
own shrinkwrap, and runs two fresh Edge.js processes. Set
`CLAWSEMBLY_ARTIFACT_CACHE` to retain verified downloads between runs.

## Status

Experimental. Three execution layers are now proven:

- Chromium executes the artifact-derived SQLite contract against official
  SQLite Wasm with OPFS persistence.
- Native Edge.js executes the exact unmodified OpenClaw state artifact through
  the kernel `node:sqlite` personality and recovers its state in a fresh
  Edge.js process.
- Chromium executes the pinned, self-built QuickJS Edge.js WASIX artifact
  through the pinned, self-built Wasmer JS runtime. The public proof records
  `argc=3`, Edge `0.0.0-554eb9b`, Node `24.13.2`, exit code 0, empty stderr,
  and an artifact SHA-256 match in
  [GitHub Actions run 30195135929](https://github.com/haya-inc/clawsembly-kernel/actions/runs/30195135929).

This does not yet claim complete OpenClaw startup. The pinned Edge.js runtime
reports Node 24.13.2, below OpenClaw's Node 24.15.0 safety floor. The browser
startup milestone proves the runtime path, argument propagation, captured
stdio, and clean process exit; it does not yet execute OpenClaw's top-level
entrypoint. QuickJS's optional JavaScript `WebAssembly` global is explicitly
disabled until its native `wasm_c_api_v0` dependency is replaced by a
browser-native OSS adapter. The next hard gate is a Node-compatible runtime at
OpenClaw's safety floor, followed by the unmodified top-level entrypoint,
capability-complete Gateway connectivity, and one real agent turn. See
[the artifact-derived SQLite contract](docs/openclaw-sqlite-contract.md) and
[the Edge.js personality proof](docs/edgejs-node-sqlite-personality.md) for the
implemented and deliberately unsupported boundaries.

## License

MIT. The `@sqlite.org/sqlite-wasm` dependency is Apache-2.0.
