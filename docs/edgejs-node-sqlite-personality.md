# Edge.js `node:sqlite` personality proof

## Proven claim

The integrity-pinned, unmodified `openclaw@2026.7.1-2` state artifact executes
inside integrity-pinned Edge.js and resolves the kernel-provided
`node:sqlite` personality. It creates the canonical 73-table,
103-explicit-index state database with SQLite 3.53.0 in WAL mode. A second,
fresh Edge.js process opens that same persisted state and recovers a row written
by the first process.

This is stronger than running a copied schema or a compatibility fixture: the
official OpenClaw state chunk itself calls `require("node:sqlite")`, configures
its pragmas, executes its schema, and performs the Kysely-generated write.

## Reproduce

```bash
npm ci
npm run test:edgejs
```

The proof runner:

1. selects the platform-specific Edge.js archive from
   `contracts/edgejs-artifact.json`;
2. verifies the archive SHA-256 before extraction;
3. downloads `openclaw@2026.7.1-2` and verifies its npm SHA-512 integrity;
4. walks the exact state chunk's static import graph;
5. obtains the reached external packages from OpenClaw's own
   `npm-shrinkwrap.json`, verifying every package integrity before extraction;
6. initializes `@sqlite.org/sqlite-wasm@3.53.0-build1` inside Edge.js;
7. registers the kernel personality for both CommonJS and ESM
   `node:sqlite` resolution;
8. imports and executes the unmodified OpenClaw state chunk;
9. rejects a database path outside the granted capability root;
10. writes and closes the canonical state database;
11. starts a different Edge.js process and verifies the prior evidence row;
12. emits a structured JSON proof and fails on any contract mismatch.

The normal CI `check` job runs this proof. Verified downloads can be reused:

```bash
CLAWSEMBLY_ARTIFACT_CACHE=.cache/clawsembly-artifacts npm run test:edgejs
```

## Pinned artifacts

- Edge.js source:
  `wasmerio/edgejs@554eb9b697ae7378290bd5f2dee1cea49a747cd7`
- Edge.js reported runtime:
  Edge `0.0.0-554eb9b`, Node `24.13.2`, V8 `13.6.233.17-node.0`
- OpenClaw: `openclaw@2026.7.1-2`
- SQLite Wasm: `@sqlite.org/sqlite-wasm@3.53.0-build1`
- OpenClaw state chunk:
  `dist/openclaw-state-db-DzSsA9Ji.js`
- State chunk SHA-256:
  `ba920b2e6f63293a27c34615fc31dcb16a20a68a1e1e34fbccdcac56a9608149`

The complete archive URLs, sizes, and digests live in the artifact contracts;
mutable package names or nightly tags are never accepted without matching the
pinned digest.

## Capability and persistence boundary

The Edge.js bootstrap grants explicit SQLite path roots. `:memory:` remains
available for OpenClaw's runtime safety probe, but a file-backed
`DatabaseSync` outside the granted roots fails with
`ERR_CLAWSEMBLY_CAPABILITY_DENIED`.

For a granted path, the personality:

- maps the host path to a non-user-controlled nested Wasm filename;
- imports existing bytes into the official SQLite Wasm POSIX VFS;
- applies exclusive locking before OpenClaw requests WAL;
- tracks every prepared statement and finalizes it on `DatabaseSync.close()`
  before closing the SQLite connection, so a retained `StatementSync` cannot
  keep the single-owner WAL lock alive across OpenClaw's sequential database
  reopen;
- persists only at autocommit boundaries;
- checkpoints WAL before serialization;
- atomically replaces the host file with mode `0600`;
- refuses native extension loading.

## Not yet proven

This proof deliberately does not claim complete OpenClaw startup:

- The pinned Edge.js reports Node 24.13.2. OpenClaw requires Node 24.15.0 or
  newer on the Node 24 line because of its SQLite WAL-reset safety gate. The
  focused state proof is safe because the injected SQLite is 3.53.0, but the
  exact top-level `openclaw.mjs` wrapper still rejects the runtime version. In
  Chromium it now exits synchronously with code 1, empty stdout, the exact
  version diagnostic, and no fall-through into `dist/entry.js`.
- The published Edge.js WASIX archive was post-processed with exception
  references. The browser lane therefore source-builds a pinned, legacy-EH,
  self-contained QuickJS artifact instead of depending on the mutable registry
  package. It also source-builds a patched Wasmer JS executor so the browser
  can compile the large module asynchronously while preserving its original
  bytes across WASIX Workers. Chromium startup, exact `process.exit` semantics,
  and the official launcher boundary for this source-pinned pair are proven by
  [GitHub Actions run 30197574607](https://github.com/haya-inc/clawsembly-kernel/actions/runs/30197574607);
  the remaining gate is a proven Node compatibility profile and the complete
  OpenClaw package graph rather than runtime startup.
- QuickJS's optional JavaScript `WebAssembly` global is disabled because its
  WASIX implementation imports native Wasmer's `wasm_c_api_v0` namespace.
  Reintroducing that surface through a browser-native OSS adapter is a tracked
  compatibility gate, not an implicit host dependency.
- The WASIX compiler sysroot is pinned to `v2025-12-10.1` so its process ABI
  matches Wasmer JS 0.10's WASIX 6.1 implementation. Newer process imports are
  not replaced with success-looking stubs.
- Filesystem, process, network, worker, WebSocket, and Gateway capability
  surfaces required by the remaining OpenClaw startup path have not yet been
  proven.

These failures are kept explicit in the emitted proof under
`remainingGates`; the test cannot turn them into a success claim.
