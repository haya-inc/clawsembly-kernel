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

- `DatabaseSync` construction for memory and OPFS paths
- `exec()`, `prepare()`, and `close()`
- `StatementSync.get()`, `all()`, `run()`, `iterate()`, and `columns()`
- positional and named bindings
- OPFS persistence across fresh Worker generations

Deliberately unavailable:

- native extension loading
- `sqlite-vec`
- file-level backup and restore
- multi-tab ownership handoff
- full error-code normalization
- Edge.js core-module registration

Unsupported behavior throws instead of silently degrading.

## Ownership

One runtime Worker owns an OPFS database at a time. Later browser tabs will
connect to that owner rather than opening competing SQLite handles. This
matches OPFS synchronous access-handle exclusivity and gives the kernel one
place to enforce capabilities, snapshots, and resource limits.
