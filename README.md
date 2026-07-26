# Clawsembly Kernel

Run the exact official OpenClaw release, unchanged, entirely inside a browser
on an open-source, self-hostable kernel — persistently, securely, and without a
proprietary runtime or remote operating system.

This is the repository's [North Star](NORTH_STAR.md). Completion requires
reproducible evidence of the real OpenClaw Gateway, a real agent turn, durable
browser-local state, and an explicit capability boundary. A mock, partial boot,
or patched OpenClaw build does not count.

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
the implemented and deliberately unsupported boundaries. Intermediate
milestones are measured against the [definition of done](NORTH_STAR.md#definition-of-done)
and do not weaken it.

## License

MIT. The `@sqlite.org/sqlite-wasm` dependency is Apache-2.0.
