# Clawsembly Kernel

A clean-room browser execution kernel for running an unmodified OpenClaw
artifact without BrowserPod.

This repository starts below Node. Browser capabilities form the kernel;
Node compatibility is a replaceable personality above it. The first vertical
slice derives a synchronous `node:sqlite` contract from a pinned official
OpenClaw artifact, then implements it on the official SQLite WebAssembly build
and OPFS.

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

## Status

Experimental. This proves a browser-native SQLite capability; it does not yet
run Edge.js or OpenClaw. See
[the artifact-derived SQLite contract](docs/openclaw-sqlite-contract.md) and
[the architecture note](docs/architecture.md) for the implemented and
deliberately unsupported boundaries.

## License

MIT. The `@sqlite.org/sqlite-wasm` dependency is Apache-2.0.
