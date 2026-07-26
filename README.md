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

Experimental. Two execution layers are now proven:

- Chromium executes the artifact-derived SQLite contract against official
  SQLite Wasm with OPFS persistence.
- Native Edge.js executes the exact unmodified OpenClaw state artifact through
  the kernel `node:sqlite` personality and recovers its state in a fresh
  Edge.js process.

This does not yet claim complete OpenClaw startup. The pinned Edge.js runtime
reports Node 24.13.2, below OpenClaw's Node 24.15.0 safety floor. The browser
runtime lane now pins a self-contained QuickJS Edge.js WASIX build and a
source-built Wasmer JS executor patched to preserve original module bytes
across Workers. Chromium startup evidence for that exact pair is the current
in-progress gate. See
[the artifact-derived SQLite contract](docs/openclaw-sqlite-contract.md) and
[the Edge.js personality proof](docs/edgejs-node-sqlite-personality.md) for the
implemented and deliberately unsupported boundaries.

## License

MIT. The `@sqlite.org/sqlite-wasm` dependency is Apache-2.0.
