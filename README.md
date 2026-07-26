# Clawsembly Kernel

A clean-room browser execution kernel for running an unmodified OpenClaw
artifact without BrowserPod.

This repository starts below Node. Browser capabilities form the kernel;
Node compatibility is a replaceable personality above it. The first vertical
slice implements the synchronous subset of `node:sqlite` used by OpenClaw on
top of the official SQLite WebAssembly build and OPFS.

## Milestone 0

The browser probe:

1. starts a dedicated Worker;
2. initializes SQLite Wasm and the OPFS SAH-pool VFS;
3. writes through `DatabaseSync` and `StatementSync` compatible classes;
4. closes the database and releases OPFS handles;
5. starts a fresh Worker;
6. verifies that the rows survived.

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
run Edge.js or OpenClaw. See [the architecture note](docs/architecture.md) for
the implemented and deliberately unsupported boundaries.

## License

MIT. The `@sqlite.org/sqlite-wasm` dependency is Apache-2.0.
