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
- multiplexes overlapping writable and read-only `DatabaseSync` wrappers for
  the same path onto one reference-counted in-process connection, allowing
  OpenClaw's long-lived state handle and read-only startup migration inspection
  to coexist without pretending the mounted browser VFS has cross-process WAL
  locks;
- preserves logical read-only semantics on a shared writable physical handle
  by installing an SQLite authorizer while compiling `prepare()` and `exec()`
  SQL, rejecting mutations with `ERR_SQLITE_READONLY`;
- tracks every prepared statement and finalizes it on `DatabaseSync.close()`
  before closing the SQLite connection, so a retained `StatementSync` cannot
  keep the single-owner WAL lock alive across OpenClaw's sequential database
  reopen;
- persists only at autocommit boundaries;
- checkpoints WAL before serialization;
- atomically replaces the host file with mode `0600`;
- refuses native extension loading.

Each logical wrapper still has independent `isOpen`, `close()`, and retained
statement state. Closing a checkpoint wrapper cannot invalidate the long-lived
wrapper; the exclusive underlying connection closes only when its final wrapper
is released. Native Edge.js builds keep normal SQLite locking and independent
connections.

## Gateway milestone and remaining North Star gates

The compiled browser binding is now exercised beyond the isolated state
contract. The source-built OpenClaw compatibility profile starts the exact
unmodified OpenClaw Gateway in normal local mode while the long-lived writable state
connection and read-only migration inspection overlap. A separate Edge.js
guest runs the official CLI and receives a valid authenticated health response
through the browser-local loopback namespace.

This still does not satisfy the North Star:

- The source-built Edge.js artifact preserves its `v24.13.2-pre` implementation
  baseline while declaring an independently audited `24.15.0` compatibility
  version for the pinned OpenClaw workload. This is a source-level runtime
  profile, not a post-build label mutation or a claim of general Node
  conformance. The exact top-level `openclaw.mjs` accepts it unchanged.
- The published Edge.js WASIX archive was post-processed with exception
  references. The browser lane therefore source-builds a pinned, legacy-EH,
  self-contained QuickJS artifact instead of depending on the mutable registry
  package. It also source-builds a patched Wasmer JS executor so the browser
  can compile the large module asynchronously while preserving its original
  bytes across WASIX Workers. Chromium startup, exact `process.exit` semantics,
  and the official launcher path for this source-pinned pair are proven by
  [GitHub Actions run 30197574607](https://github.com/haya-inc/clawsembly-kernel/actions/runs/30197574607);
  current CI additionally requires source-baseline/compatibility-version
  separation, SQLite 3.53.4, the exact unmodified package hashes, Gateway
  health, and the agent turn to pass on one artifact.
- QuickJS's JavaScript `WebAssembly` global is backed by a statically linked
  `wasmi` C API compiled into the WASIX guest. Chromium proves nested module
  compilation and execution without native Wasmer imports or ambient
  capabilities.
- The WASIX compiler sysroot is pinned to `v2025-12-10.1` so its process ABI
  matches Wasmer JS 0.10's WASIX 6.1 implementation. Newer process imports are
  not replaced with success-looking stubs.
- Required lifecycle effects are proven by the version-bound browser install
  contract. The generation-addressed OPFS store separately proves recovery of
  that official state after a complete browser restart. The deterministic
  browser fixture proves the unmodified Gateway-backed agent path and its
  capability-authorized TCP transport. A separate lane proves a live model
  response over guest-validated TLS. That compatibility lane still injects a
  short-lived job token into guest memory and relies on a DNS-derived TCP
  restriction, so an opaque provider-credential broker remains unproven.

This remaining credential-boundary gate stays explicit in the evidence;
Gateway health or a raw-token TLS proof cannot silently turn it into a
completion claim.
