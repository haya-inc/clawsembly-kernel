import {
  OPENCLAW_ARTIFACT,
  OPENCLAW_STATE_SCHEMA_SHA256,
  OPENCLAW_STATE_SCHEMA_SQL
} from "./generated/openclaw-state-schema";

const EXPECTED_TABLES = 73;
const EXPECTED_INDEXES = 103;
const MINIMUM_SAFE_SQLITE_VERSION = "3.51.3";

type SqliteRow = Record<string, unknown>;

type RunResult = {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
};

type StatementContract = {
  all(...parameters: unknown[]): unknown[];
  columns(): Array<{ name: string }>;
  get(...parameters: unknown[]): unknown;
  iterate(...parameters: unknown[]): Iterable<unknown>;
  run(...parameters: unknown[]): RunResult;
};

export type DatabaseContract = {
  exec(sql: string): void;
  prepare(sql: string): StatementContract;
};

export type OpenClawSqliteEvidence = {
  artifact: typeof OPENCLAW_ARTIFACT;
  databasePath: string;
  readOnly: boolean;
  sqliteVersion: string;
  minimumSafeSqliteVersion: string;
  stateSchema: {
    sha256: string;
    expectedTables: number;
    expectedIndexes: number;
    tables: number;
    indexes: number;
    userVersion: number;
    schemaMetaColumns: string[];
    primary: {
      metaKey: string;
      role: string;
      schemaVersion: number;
      agentId: string | null;
      appVersion: string | null;
    };
  };
  pragmas: {
    busyTimeoutMs: number;
    journalMode: string;
    lockingMode: string;
    walAutocheckpointPages: number;
    synchronous: number;
    foreignKeys: number;
  };
  transaction?: {
    changes: number;
    rows: string[];
    rolledBackRowAbsent: boolean;
  };
  storageOperations?: {
    attachedValue: string;
    snapshotTables: number;
    snapshotIndexes: number;
    snapshotPrimaryRole: string;
  };
};

export type OpenClawStoragePaths = {
  attachedDatabasePath: string;
  snapshotDatabasePath: string;
};

function asRow(value: unknown, label: string): SqliteRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} did not return a row`);
  }
  return value as SqliteRow;
}

function firstValue(database: DatabaseContract, sql: string): unknown {
  const row = asRow(database.prepare(sql).get(), sql);
  return Object.values(row)[0];
}

function asNumber(value: unknown, label: string): number {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`${label} is not numeric`);
  return result;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is not a string`);
  return value;
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function assertStateEvidence(evidence: OpenClawSqliteEvidence): void {
  if (compareVersions(evidence.sqliteVersion, MINIMUM_SAFE_SQLITE_VERSION) < 0) {
    throw new Error(
      `SQLite ${evidence.sqliteVersion} is older than OpenClaw's safe minimum `
      + MINIMUM_SAFE_SQLITE_VERSION
    );
  }
  if (evidence.stateSchema.tables !== EXPECTED_TABLES) {
    throw new Error(
      `expected ${EXPECTED_TABLES} OpenClaw tables, found ${evidence.stateSchema.tables}`
    );
  }
  if (evidence.stateSchema.indexes !== EXPECTED_INDEXES) {
    throw new Error(
      `expected ${EXPECTED_INDEXES} OpenClaw indexes, found ${evidence.stateSchema.indexes}`
    );
  }
  if (evidence.stateSchema.userVersion !== 1) {
    throw new Error(`expected OpenClaw user_version 1, found ${evidence.stateSchema.userVersion}`);
  }
  if (
    evidence.stateSchema.primary.metaKey !== "primary"
    || evidence.stateSchema.primary.role !== "global"
    || evidence.stateSchema.primary.schemaVersion !== 1
  ) {
    throw new Error("OpenClaw schema_meta primary record is not canonical");
  }
}

function collectEvidence(
  database: DatabaseContract,
  databasePath: string,
  readOnly: boolean
): OpenClawSqliteEvidence {
  const tableRows = database.prepare(`
    SELECT name
    FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((value) => asRow(value, "table catalog"));
  const indexRows = database.prepare(`
    SELECT name
    FROM sqlite_schema
    WHERE type = 'index' AND sql IS NOT NULL
    ORDER BY name
  `).all().map((value) => asRow(value, "index catalog"));
  const metaStatement = database.prepare(`
    SELECT meta_key, role, schema_version, agent_id, app_version
    FROM schema_meta
    WHERE meta_key = ?
  `);
  const primary = asRow(metaStatement.get("primary"), "schema_meta primary");
  const iteratedPrimary = Array.from(metaStatement.iterate("primary"));
  if (iteratedPrimary.length !== 1) {
    throw new Error(`StatementSync.iterate() returned ${iteratedPrimary.length} primary rows`);
  }

  const evidence: OpenClawSqliteEvidence = {
    artifact: OPENCLAW_ARTIFACT,
    databasePath,
    readOnly,
    sqliteVersion: asString(firstValue(database, "SELECT sqlite_version()"), "sqlite_version()"),
    minimumSafeSqliteVersion: MINIMUM_SAFE_SQLITE_VERSION,
    stateSchema: {
      sha256: OPENCLAW_STATE_SCHEMA_SHA256,
      expectedTables: EXPECTED_TABLES,
      expectedIndexes: EXPECTED_INDEXES,
      tables: tableRows.length,
      indexes: indexRows.length,
      userVersion: asNumber(firstValue(database, "PRAGMA user_version"), "user_version"),
      schemaMetaColumns: metaStatement.columns().map((column) => column.name),
      primary: {
        metaKey: asString(primary.meta_key, "schema_meta.meta_key"),
        role: asString(primary.role, "schema_meta.role"),
        schemaVersion: asNumber(primary.schema_version, "schema_meta.schema_version"),
        agentId: primary.agent_id as string | null,
        appVersion: primary.app_version as string | null
      }
    },
    pragmas: {
      busyTimeoutMs: asNumber(firstValue(database, "PRAGMA busy_timeout"), "busy_timeout"),
      journalMode: asString(firstValue(database, "PRAGMA journal_mode"), "journal_mode").toLowerCase(),
      lockingMode: asString(firstValue(database, "PRAGMA locking_mode"), "locking_mode").toLowerCase(),
      walAutocheckpointPages: asNumber(
        firstValue(database, "PRAGMA wal_autocheckpoint"),
        "wal_autocheckpoint"
      ),
      synchronous: asNumber(firstValue(database, "PRAGMA synchronous"), "synchronous"),
      foreignKeys: asNumber(firstValue(database, "PRAGMA foreign_keys"), "foreign_keys")
    }
  };
  assertStateEvidence(evidence);
  return evidence;
}

export function initializeOpenClawStateContract(
  database: DatabaseContract,
  databasePath: string,
  storagePaths: OpenClawStoragePaths
): OpenClawSqliteEvidence {
  database.exec("PRAGMA busy_timeout = 30000;");
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA wal_autocheckpoint = 1000;");
  database.exec("PRAGMA synchronous = NORMAL;");
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec(OPENCLAW_STATE_SCHEMA_SQL);
  database.exec("PRAGMA user_version = 1;");
  database.exec(`
    CREATE TEMP TABLE IF NOT EXISTS clawsembly_transaction_probe (
      value TEXT NOT NULL
    ) STRICT;
    DELETE FROM clawsembly_transaction_probe;
  `);

  let primaryInsert: RunResult;
  try {
    database.exec("BEGIN IMMEDIATE");
    const now = Date.now();
    primaryInsert = database.prepare(`
      INSERT INTO schema_meta (
        meta_key, role, schema_version, agent_id, app_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(meta_key) DO UPDATE SET
        role = excluded.role,
        schema_version = excluded.schema_version,
        agent_id = excluded.agent_id,
        app_version = excluded.app_version,
        updated_at = excluded.updated_at
    `).run("primary", "global", 1, null, null, now, now);
    database.prepare(
      "INSERT INTO clawsembly_transaction_probe(value) VALUES (?)"
    ).run("outer");
    database.exec("SAVEPOINT clawsembly_nested_rollback");
    database.prepare(
      "INSERT INTO clawsembly_transaction_probe(value) VALUES (?)"
    ).run("rolled-back");
    database.exec("ROLLBACK TO SAVEPOINT clawsembly_nested_rollback");
    database.exec("RELEASE SAVEPOINT clawsembly_nested_rollback");
    database.exec("SAVEPOINT clawsembly_nested_release");
    database.prepare(
      "INSERT INTO clawsembly_transaction_probe(value) VALUES (?)"
    ).run("released");
    database.exec("RELEASE SAVEPOINT clawsembly_nested_release");
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original transaction failure.
    }
    throw error;
  }

  database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  const evidence = collectEvidence(database, databasePath, false);
  const transactionRows = Array.from(
    database.prepare(
      "SELECT value FROM clawsembly_transaction_probe ORDER BY rowid"
    ).iterate()
  ).map((value) => asString(asRow(value, "transaction probe").value, "transaction value"));
  evidence.transaction = {
    changes: asNumber(primaryInsert.changes, "primary insert changes"),
    rows: transactionRows,
    rolledBackRowAbsent: !transactionRows.includes("rolled-back")
  };

  if (
    evidence.pragmas.busyTimeoutMs !== 30_000
    || evidence.pragmas.journalMode !== "wal"
    || evidence.pragmas.walAutocheckpointPages !== 1_000
    || evidence.pragmas.synchronous !== 1
    || evidence.pragmas.foreignKeys !== 1
  ) {
    throw new Error(`OpenClaw connection pragmas were not preserved: ${JSON.stringify(evidence.pragmas)}`);
  }
  if (
    transactionRows.join(",") !== "outer,released"
    || !evidence.transaction.rolledBackRowAbsent
  ) {
    throw new Error(`nested savepoint contract failed: ${transactionRows.join(",")}`);
  }

  database.prepare("ATTACH DATABASE ? AS clawsembly_attached").run(
    storagePaths.attachedDatabasePath
  );
  let attachedValue: string;
  try {
    database.exec(`
      CREATE TABLE clawsembly_attached.contract_probe (
        value TEXT NOT NULL
      ) STRICT;
      INSERT INTO clawsembly_attached.contract_probe(value) VALUES ('attached');
    `);
    attachedValue = asString(
      firstValue(database, "SELECT value FROM clawsembly_attached.contract_probe"),
      "attached database value"
    );
  } finally {
    database.exec("DETACH DATABASE clawsembly_attached");
  }

  database.prepare("VACUUM INTO ?").run(storagePaths.snapshotDatabasePath);
  database.prepare("ATTACH DATABASE ? AS clawsembly_snapshot").run(
    storagePaths.snapshotDatabasePath
  );
  try {
    evidence.storageOperations = {
      attachedValue,
      snapshotTables: asNumber(
        firstValue(database, `
          SELECT count(*)
          FROM clawsembly_snapshot.sqlite_schema
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        `),
        "snapshot table count"
      ),
      snapshotIndexes: asNumber(
        firstValue(database, `
          SELECT count(*)
          FROM clawsembly_snapshot.sqlite_schema
          WHERE type = 'index' AND sql IS NOT NULL
        `),
        "snapshot index count"
      ),
      snapshotPrimaryRole: asString(
        firstValue(database, `
          SELECT role
          FROM clawsembly_snapshot.schema_meta
          WHERE meta_key = 'primary'
        `),
        "snapshot primary role"
      )
    };
  } finally {
    database.exec("DETACH DATABASE clawsembly_snapshot");
  }
  if (
    evidence.storageOperations.attachedValue !== "attached"
    || evidence.storageOperations.snapshotTables !== EXPECTED_TABLES
    || evidence.storageOperations.snapshotIndexes !== EXPECTED_INDEXES
    || evidence.storageOperations.snapshotPrimaryRole !== "global"
  ) {
    throw new Error(
      `attached database or snapshot contract failed: ${JSON.stringify(evidence.storageOperations)}`
    );
  }
  return evidence;
}

export function readOpenClawStateContract(
  database: DatabaseContract,
  databasePath: string
): OpenClawSqliteEvidence {
  return collectEvidence(database, databasePath, true);
}
