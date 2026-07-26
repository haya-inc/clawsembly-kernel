# Architecture

## Decision

Clawsembly Kernel is a clean-room browser execution substrate. It does not
implement the existing Clawsembly `BrowserRuntime` contract and does not import
the BrowserPod adapter. Compatibility is derived from the behavior of the
unmodified OpenClaw artifact and from browser platform constraints.

The first personality surface is `node:sqlite`:

```text
OpenClaw require("node:sqlite")
  -> Node core-module personality
  -> synchronous DatabaseSync / StatementSync adapter
  -> official SQLite Wasm
  -> OPFS SAH-pool VFS
```

The runtime and SQLite execute in one dedicated Worker. After asynchronous
kernel initialization, database operations remain synchronous from the Node
personality's point of view.

## Milestone 0 boundary

Implemented:

- artifact integrity verification and deterministic contract generation
- the exact state schema from the pinned official OpenClaw artifact
- `DatabaseSync` construction for memory and OPFS paths
- `exec()`, `prepare()`, and `close()`
- `StatementSync.get()`, `all()`, `run()`, `iterate()`, and `columns()`
- positional and named bindings
- OpenClaw's busy timeout, WAL, autocheckpoint, `synchronous=NORMAL`, and
  foreign-key pragmas
- `BEGIN IMMEDIATE`, nested savepoint rollback/release, and WAL checkpoint
- bound `ATTACH DATABASE ?` and `VACUUM INTO ?`, including snapshot validation
- OPFS persistence across fresh Worker generations

Deliberately unavailable:

- native extension loading
- `sqlite-vec`
- complete OpenClaw backup archive and restore orchestration
- multi-tab ownership handoff
- full error-code normalization
- Edge.js core-module registration

Unsupported behavior throws instead of silently degrading.

## OPFS WAL precondition

The official SQLite Wasm build requires `locking_mode=EXCLUSIVE` before the
first database operation in order to activate WAL on OPFS. The OPFS
`DatabaseSync` personality applies that storage precondition in its constructor
before the unmodified OpenClaw code can issue SQL. Native Node remains in
`locking_mode=NORMAL`.

This difference is explicit in the browser evidence and covered by the
differential test. It does not rewrite or skip OpenClaw's own WAL configuration.
See SQLite's
[WAL Mode with OPFS](https://sqlite.org/wasm/doc/trunk/persistence.md#wal_mode_with_opfs)
documentation.

## Ownership

One runtime Worker owns an OPFS database at a time. Later browser tabs will
connect to that owner rather than opening competing SQLite handles. This
matches OPFS synchronous access-handle exclusivity and gives the kernel one
place to enforce capabilities, snapshots, and resource limits.
