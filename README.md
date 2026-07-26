# Clawsembly Kernel

Run one exact, officially published OpenClaw release, unchanged, entirely
inside a browser on an open-source, self-hostable kernel — persistently,
securely, and without a proprietary execution substrate or remote operating
system.

## North Star

This repository's binding objective and completion criteria are defined in
[NORTH_STAR.md](NORTH_STAR.md). Completion requires reproducible public
evidence of:

- persistent OpenClaw state;
- sufficient Node compatibility to start the official entrypoint;
- explicit filesystem, network, process, and secret capability boundaries;
- an OpenClaw Gateway connection; and
- one real agent turn.

A mock, partial boot, or patched OpenClaw build does not count. Partial
compatibility probes are milestones toward the result, not alternate
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

Experimental. Current execution milestones:

- Chromium executes the artifact-derived SQLite contract against official
  SQLite Wasm with OPFS persistence.
- Native Edge.js executes the exact unmodified OpenClaw state artifact through
  the kernel `node:sqlite` personality and recovers its state in a fresh
  Edge.js process.
- Chromium executes the pinned, self-built QuickJS Edge.js WASIX artifact
  through the pinned, self-built Wasmer JS runtime. The latest public proof
  records Edge `0.0.0-554eb9b`, Node `24.13.2`, an exact
  `process.exit(7)` unwind, and an artifact SHA-256 match. It then executes the
  official `openclaw@2026.7.1-2` launcher from its integrity-pinned npm
  archive in
  [GitHub Actions run 30197574607](https://github.com/haya-inc/clawsembly-kernel/actions/runs/30197574607).
- The exact OpenClaw shrinkwrap is materialized as a deterministic
  browser-mountable image: 308 integrity-pinned runtime archives, 32,027 files,
  and exact hashes for `openclaw.mjs`, `dist/entry.js`, `package.json`, and
  `npm-shrinkwrap.json`. Chromium mounts and verifies the whole image without
  rewriting OpenClaw.
- Edge.js now has an auditable optional `internalBinding("sqlite")` patch. It
  compiles the official SQLite 3.53.4 amalgamation directly into the QuickJS
  WASIX runtime, disables extension loading, and passes the OpenClaw-reached
  synchronous API, transaction, savepoint, WAL, checkpoint, read-only, and
  persistence contract in a native QuickJS build.

This does not yet claim complete OpenClaw startup. The pinned Edge.js runtime
reports Node 24.13.2, below OpenClaw's Node 24.15.0 safety floor. The official
launcher now stops synchronously at that version gate with exit code 1, empty
stdout, the exact diagnostic, and no fall-through into `dist/entry.js`. The
runtime will not be relabeled until a compatibility profile proves the
required Node surfaces. SQLite WAL-reset safety is pinned to 3.53.4 and the
browser CI now must prove that same compiled binding in Chromium before it can
remove the first Gateway blocker. QuickJS's optional
JavaScript `WebAssembly` global is explicitly disabled until its native
`wasm_c_api_v0` dependency is replaced by a browser-native OSS adapter. The
next hard gate is the rebuilt Chromium artifact advancing the exact unmodified
Gateway beyond `requireNodeSqlite()`, followed by Gateway readiness,
capability-complete connectivity, durable OPFS ownership, and one real agent
turn. See
[the artifact-derived SQLite contract](docs/openclaw-sqlite-contract.md) and
[the Edge.js personality proof](docs/edgejs-node-sqlite-personality.md) for the
implemented and deliberately unsupported boundaries.

## License

MIT. The `@sqlite.org/sqlite-wasm` dependency is Apache-2.0.
