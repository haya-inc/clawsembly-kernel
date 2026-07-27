# Artifact-derived OpenClaw SQLite contract

This milestone answers one narrow question: can the browser kernel preserve
the SQLite state contract required by the exact official OpenClaw artifact?
This contract by itself does not claim that OpenClaw starts; later browser
runtime evidence carries that separate claim.

## Source of truth

[`contracts/openclaw-artifact.json`](../contracts/openclaw-artifact.json) pins:

- package: `openclaw@2026.7.1-2`
- npm SHA-512 integrity:
  `sha512-ycF3yPcbjN6bUPeaUx6Mh6vze1hQWoD3CT/wWcmD7a8xaHHHRUaAlaq+lFxMHf1ssEgODVAwjlzYqp2twkYZ7g==`
- official npm tarball URL
- declared Node engine range

`npm run contract:generate` downloads that tarball, rejects any integrity
mismatch, extracts the generated state schema, and scans the distributed
JavaScript for SQLite behavior. It writes:

- [`contracts/openclaw-sqlite-contract.generated.json`](../contracts/openclaw-sqlite-contract.generated.json)
- [`src/generated/openclaw-state-schema.ts`](../src/generated/openclaw-state-schema.ts)

`npm run contract:check` regenerates both files in memory and fails if committed
evidence is missing or stale.

## Current proof

The same runner executes on native Node `node:sqlite` and the browser
`DatabaseSync` personality. The browser side is then reopened from a fresh
read-only Worker.

Proven in Chromium:

- state schema SHA-256
  `290198b5e8fb37f5b4a43fcce041bb91d0c1e23a8cc9730144b138f436e34093`
- 73 state tables and 103 explicit indexes
- `user_version=1` and canonical `schema_meta` primary record
- SQLite 3.51.3 or newer
- `StatementSync.get()`, `all()`, `run()`, `iterate()`, and `columns()`
- `busy_timeout=30000`, WAL, autocheckpoint 1000, `synchronous=NORMAL`, and
  foreign keys
- `BEGIN IMMEDIATE`
- nested savepoint rollback and release
- WAL truncate checkpoint
- bound `ATTACH DATABASE ?` with an independently queried auxiliary database
- bound `VACUUM INTO ?` with validation of the resulting 73-table,
  103-index state snapshot
- persistence across two Worker generations
- read-only reopen
- semantic equivalence with native Node for the state contract

## Known gaps

The artifact also requires behaviors not yet proven by this milestone:

- extension loading and `sqlite-vec`
- complete backup archive and restore orchestration above the SQLite snapshot

The Edge.js browser lane now registers a separately audited compiled
`node:sqlite` personality and proves overlapping writable/read-only startup
access. The remaining items stay explicit failures or unproven requirements;
they are not emulated with remote storage and are not counted as passing.

## Reproduce

```bash
npm install
npm run check
```

The browser evidence is rendered by the local probe and asserted in
[`tests/sqlite-persistence.spec.ts`](../tests/sqlite-persistence.spec.ts).
