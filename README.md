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
private or special-use destinations. It also defaults to four simultaneous
guest connections and 2 MiB WebSocket frames. Use `--allow-private-network`
only for an intentional private target.

For the interactive probe:

```bash
npm run dev
```

For a digest-verified local llama.cpp/Qwen run of the complete browser proof,
see the [self-host guide](docs/self-host.md) or run:

```bash
npm run self-host:prove -- --help
```

For the proof-bound Cloudflare Worker + R2 production distribution at
`clawsembly.yhay81.com`, see the
[Cloudflare deployment guide](docs/cloudflare-deployment.md). Its preparation
step refuses unproven runtime inputs, builds against the exact patched Wasmer
SDK from the public proof, and keeps the 68 MB Edge.js and 317 MB OpenClaw
objects outside the 25 MiB Static Assets boundary.

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
- The required install lifecycle effects now execute inside Chromium before
  Gateway startup. The exact root pre/postinstall and `protobufjs` postinstall
  scripts complete against one shared capability filesystem; the official
  postinstall creates a SQLite-backed registry with 33 indexed plugins, which
  a fresh Edge.js process reopens and verifies. The Google hook is an audited
  literal no-op, while OpenClaw's own `allowBuilds` policy disables the unused
  `tree-sitter-bash` native build in favor of its published Wasm grammar.
- The mutable OpenClaw capability directory now has a generation-addressed
  OPFS store. Chromium commits every file with a SHA-256 manifest, closes the
  complete browser process, reopens the same origin profile, restores a new
  Wasmer `Directory`, and uses a new Edge.js process to reopen the exact
  official postinstall SQLite registry without re-running installation. A
  second restored directory then starts the unmodified Gateway and completes
  its authenticated health RPC.
- The public source-build lane also runs an actual self-hosted model proof.
  A checksum-pinned llama.cpp release loads the Apache-2.0 Qwen2.5 0.5B
  Instruct GGUF on host loopback. The unmodified OpenClaw CLI asks the
  unmodified Gateway for one agent turn and receives the strict assistant
  marker under a broker-enforced zero-temperature request. Only a one-request
  operation capability enters the browser; the
  GGUF, inference process, and model-service API key remain outside both WASIX
  guests. The proof job has no repository or external AI-service permission.
- The official OpenClaw tool path now has a browser-workspace proof. A
  deterministic model protocol asks unmodified OpenClaw to write, read, and
  attempt one forbidden outside-workspace write. The resulting workspace is
  committed to OPFS and restored into a fresh guest Directory with manifest
  and per-file SHA-256 verification.
- The guest model capability now has a short TTL and a separate host-only
  revocation endpoint. The proof revokes it after the successful Qwen turn,
  retries with the former guest token, and requires HTTP 403 without another
  provider request. The TCP relay independently bounds concurrent guests and
  WebSocket frame size.
- A weekly update workflow compares the pinned official OpenClaw artifact with
  npm's latest tag and opens or refreshes a compatibility-evaluation issue.
  It never bumps the release without regenerating the version-bound proofs.

The North Star is complete for the pinned `openclaw@2026.7.1-2` release and
the demonstrated workload. The immutable
[public source-build proof](https://github.com/haya-inc/clawsembly-kernel/actions/runs/30407132572)
rebuilds the runtime and records Gateway health, deterministic and self-hosted
agent turns, workspace tools, fresh-browser OPFS recovery, least-privilege
capability revocation, and the required post-revocation HTTP 403. The
source-built runtime has an explicit, workload-scoped Node compatibility
profile: it transparently separates the Edge.js `v24.13.2-pre` implementation
baseline from the `24.15.0` version exposed to OpenClaw, and proves why that
floor is safe for this workload instead of claiming general Node conformance.
SQLite WAL-reset safety is pinned to 3.53.4 and its compiled browser binding is
proven. This closes the model-service credential boundary for the demonstrated
path. It does not claim complete compatibility for every OpenClaw plugin, tool,
channel, general Node.js workload, or hostile multi-tenant deployment.
See
[the artifact-derived SQLite contract](docs/openclaw-sqlite-contract.md) and
[the Node compatibility profile](docs/node-compatibility-profile.md). The
[install lifecycle contract](docs/openclaw-install-lifecycle.md) records the
executed effects and deliberately unauthorized native build. The
[OPFS directory store](docs/opfs-directory-store.md) records the commit,
integrity, recovery, and browser-restart contract. The
[model capability broker](docs/model-capability-broker.md) records the
self-hosted inference and credential boundary. The
[North Star completion audit](docs/north-star-audit.md) maps every completion
criterion to its executable public evidence and defines the scope of the
completion claim.

## License

MIT. The `@sqlite.org/sqlite-wasm` dependency is Apache-2.0.
