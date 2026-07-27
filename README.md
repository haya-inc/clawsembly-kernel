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

The optional outbound-TCP broker is built from the same pinned dependency
patch contract used by CI:

```bash
node scripts/apply-cargo-dependency-patches.mjs \
  --manifest relay/Cargo.toml \
  --package virtual-net
cargo build --locked --release --manifest-path relay/Cargo.toml
CLAWSEMBLY_NETWORK_RELAY_TOKEN=replace-with-a-capability-token \
  relay/target/release/clawsembly-network-relay \
  --allow api.example.com:443
```

The relay defaults to loopback, exact DNS names and ports, and denial of
private or special-use destinations. Use `--allow-private-network` only for an
intentional private target.

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
  through the pinned, self-built Wasmer JS runtime. The base proof records Edge
  `0.0.0-554eb9b`, the `v24.13.2-pre` source baseline, the source-declared
  OpenClaw compatibility version `24.15.0`, an exact
  `process.exit(7)` unwind, an artifact SHA-256 match, and browser-local TCP
  communication between two isolated guest processes. It then executes the
  official `openclaw@2026.7.1-2` launcher from its integrity-pinned npm
  archive in the
  [public browser build workflow](https://github.com/haya-inc/clawsembly-kernel/actions/workflows/edgejs-wasix-build.yml).
- The exact OpenClaw shrinkwrap is materialized as a deterministic
  browser-mountable image: 308 integrity-pinned runtime archives, 32,027 files,
  and exact hashes for `openclaw.mjs`, `dist/entry.js`, `package.json`, and
  `npm-shrinkwrap.json`. Chromium mounts and verifies the whole image without
  rewriting OpenClaw.
- Edge.js now has an auditable optional `internalBinding("sqlite")` patch. It
  compiles the official SQLite 3.53.4 amalgamation directly into the QuickJS
  WASIX runtime, disables extension loading, and passes the OpenClaw-reached
  synchronous API, transaction, savepoint, WAL, checkpoint, read-only, and
  persistence contract in a native QuickJS build. Chromium also proves the
  compiled binding with automatic exclusive locking, WAL, and a fresh-process
  read in
  [GitHub Actions run 30201564289](https://github.com/haya-inc/clawsembly-kernel/actions/runs/30201564289).
- The runtime now provides a capability-scoped browser-local loopback
  namespace. Two separate Edge.js guest processes listen and connect at
  `127.0.0.1:18790`, exchange `ping`/`pong`, and close cleanly. A separate
  guest proves that external egress is denied by default with `EPERM`. Each
  public build records the exact Edge.js WASIX digest in its final evidence
  artifact.
- Edge.js now declares its OpenClaw-scoped Node compatibility version in source
  rather than rewriting a built Wasm artifact. The contract records that this
  is not an official Node binary, preserves `v24.13.2-pre` as the implementation
  baseline, and gates the `24.15.0` compatibility claim on the actual SQLite
  3.53.4 runtime query, unmodified package integrity, Gateway health RPC, and
  agent-turn proofs. The official launcher, Gateway, and separate official CLI
  guest all consume the same source-built Wasm artifact.
- The browser runtime now has an optional, default-deny outbound-TCP
  capability without replacing browser-local loopback. A self-hostable
  MIT-licensed relay authenticates by WebSocket subprotocol, exposes only DNS
  and outbound TCP, and independently enforces exact DNS-name/port grants and
  private-address denial. The deterministic browser proof covers local
  `ping`/`pong`, one explicitly granted external fixture, and wrong-port,
  unlisted-host, and raw-IP denials.
- QuickJS now exposes guest JavaScript `WebAssembly` without native Wasmer or
  a proprietary host namespace. Edge.js statically links the
  MIT/Apache-2.0 `wasmi` C API, and Chromium proves a nested Wasm module
  compiling, instantiating, and returning `42` with no ambient capability.
- The unmodified official OpenClaw Gateway and a separate official CLI guest
  now execute the complete agent path through browser-local loopback. The
  Gateway sends the OpenAI-compatible streaming request through the
  capability-scoped relay to a deterministic fixture and returns its exact
  assistant marker. The test also guards QuickJS's ECMAScript
  `WeakRef` keep-during-job semantics, which Undici requires to return a
  `Response` rather than `undefined`.

This does not yet claim the North Star is complete. The source-built runtime now
has an explicit, workload-scoped Node compatibility profile: it transparently
separates the Edge.js `v24.13.2-pre` implementation baseline from the `24.15.0`
version exposed to OpenClaw, and proves why that floor is safe for this workload
instead of claiming general Node conformance. SQLite WAL-reset safety is pinned
to 3.53.4 and its compiled browser binding is proven. Nested JavaScript
WebAssembly and the deterministic Gateway-backed agent path are also proven.
Required lifecycle effects, a live TLS model-provider exchange through the new
capability, and durable OPFS ownership across a fresh browser session remain
open. See
[the artifact-derived SQLite contract](docs/openclaw-sqlite-contract.md) and
[the Node compatibility profile](docs/node-compatibility-profile.md) for the
implemented and deliberately unsupported boundaries.

## License

MIT. The `@sqlite.org/sqlite-wasm` dependency is Apache-2.0.
