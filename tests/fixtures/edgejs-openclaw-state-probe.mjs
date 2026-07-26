import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  readFileSync,
  readdirSync,
  statSync
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { installEdgeJsKernel } from "./bootstrap.mjs";

const [mode, statePath, openClawPackagePath] = process.argv.slice(2);
assert.ok(mode === "write" || mode === "read", `Unexpected probe mode: ${mode}`);
assert.ok(statePath, "Missing state database path");
assert.ok(openClawPackagePath, "Missing extracted OpenClaw package path");

const stateRoot = path.dirname(path.resolve(statePath));
const kernel = await installEdgeJsKernel({
  sqlite: { allowedPathRoots: [stateRoot] }
});
const require = createRequire(import.meta.url);
const commonJsSqlite = require("node:sqlite");
const esmSqlite = await import("node:sqlite");
assert.equal(commonJsSqlite, kernel.personality);
assert.equal(esmSqlite.DatabaseSync, kernel.personality.DatabaseSync);

let capabilityDenied = false;
try {
  new commonJsSqlite.DatabaseSync(path.join(path.dirname(stateRoot), "denied.sqlite3"));
} catch (error) {
  capabilityDenied = error?.code === "ERR_CLAWSEMBLY_CAPABILITY_DENIED";
}
assert.equal(capabilityDenied, true, "SQLite path capability boundary did not deny an escape");

const stateChunkName = readdirSync(path.join(openClawPackagePath, "dist"))
  .find((name) => /^openclaw-state-db-[A-Za-z0-9_-]+\.js$/u.test(name));
assert.ok(stateChunkName, "Official OpenClaw state chunk was not found");
const stateChunkPath = path.join(openClawPackagePath, "dist", stateChunkName);
const stateChunkSha256 = createHash("sha256")
  .update(readFileSync(stateChunkPath))
  .digest("hex");
const openClawState = await import(pathToFileURL(stateChunkPath).href);
assert.equal(
  openClawState.m(),
  kernel.personality,
  "Unmodified OpenClaw did not resolve the kernel node:sqlite personality"
);

const opened = openClawState.i({ path: statePath });
const database = opened.db;
if (mode === "write") {
  database.prepare(`
    INSERT INTO schema_meta (
      meta_key, role, schema_version, agent_id, app_version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(meta_key) DO UPDATE SET
      role=excluded.role,
      schema_version=excluded.schema_version,
      agent_id=excluded.agent_id,
      app_version=excluded.app_version,
      updated_at=excluded.updated_at
  `).run(
    "clawsembly-edgejs-evidence",
    "kernel-proof",
    1,
    "edgejs",
    "openclaw-unmodified",
    1,
    1
  );
}

const evidenceRow = database.prepare(`
  SELECT meta_key, role, schema_version, agent_id, app_version
  FROM schema_meta
  WHERE meta_key = ?
`).get("clawsembly-edgejs-evidence");
assert.deepEqual(evidenceRow, {
  meta_key: "clawsembly-edgejs-evidence",
  role: "kernel-proof",
  schema_version: 1,
  agent_id: "edgejs",
  app_version: "openclaw-unmodified"
});

const sqliteVersion = database.prepare("SELECT sqlite_version() AS version").get().version;
const journalMode = database.prepare("PRAGMA journal_mode").get().journal_mode;
const lockingMode = database.prepare("PRAGMA locking_mode").get().locking_mode;
const userVersion = database.prepare("PRAGMA user_version").get().user_version;
const tables = database.prepare(`
  SELECT count(*) AS count
  FROM sqlite_master
  WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
`).get().count;
const indexes = database.prepare(`
  SELECT count(*) AS count
  FROM sqlite_master
  WHERE type = 'index' AND sql IS NOT NULL
`).get().count;
openClawState.n();

const persistedBytes = readFileSync(statePath);
const packageJson = JSON.parse(
  readFileSync(path.join(openClawPackagePath, "package.json"), "utf8")
);
const evidence = {
  schemaVersion: 1,
  phase: mode,
  artifact: {
    name: packageJson.name,
    version: packageJson.version,
    stateChunk: `dist/${stateChunkName}`,
    stateChunkSha256,
    requiredNodeSqlitePersonality: openClawState.m() === kernel.personality
  },
  moduleSurfaces: {
    commonjs: commonJsSqlite === kernel.personality,
    esmNamedExport: esmSqlite.DatabaseSync === kernel.personality.DatabaseSync
  },
  runtime: {
    ...kernel.runtime,
    pid: process.pid
  },
  sqlite: {
    version: sqliteVersion,
    journalMode,
    lockingMode,
    userVersion,
    tables,
    explicitIndexes: indexes
  },
  capability: {
    allowedPathRoot: "<state-capability-root>",
    deniedPathEscape: capabilityDenied
  },
  persistence: {
    bytes: statSync(statePath).size,
    sqliteHeader: persistedBytes.subarray(0, 16).toString("utf8"),
    evidenceRow
  }
};
console.log(`CLAWSEMBLY_EVIDENCE=${JSON.stringify(evidence)}`);
