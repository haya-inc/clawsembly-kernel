/// <reference lib="webworker" />

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { createNodeSqliteModule } from "./node-sqlite";
import type { ProbeCommand, ProbeEvidence, ProbeResponse } from "./protocol";

declare const self: DedicatedWorkerGlobalScope;

function errorResponse(id: string, error: unknown): ProbeResponse {
  return {
    id,
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.stack ? { stack: error.stack } : {})
  };
}

async function run(command: ProbeCommand): Promise<ProbeEvidence> {
  const sqlite3 = await sqlite3InitModule();
  const vfsName = "clawsembly-kernel-m0";
  const sahPool = await sqlite3.installOpfsSAHPoolVfs({
    initialCapacity: 6,
    name: vfsName
  });
  const { DatabaseSync } = createNodeSqliteModule(sqlite3, vfsName);
  const database = new DatabaseSync(command.databasePath, {
    readOnly: command.kind === "read"
  });

  try {
    if (command.kind === "write") {
      database.exec(`
        DROP TABLE IF EXISTS kernel_probe;
        CREATE TABLE kernel_probe (
          id INTEGER PRIMARY KEY,
          value TEXT NOT NULL
        ) STRICT;
      `);
      const insert = database.prepare(
        "INSERT INTO kernel_probe(value) VALUES (?)"
      );
      const first = insert.run("written-by-worker-one");
      database.prepare(
        "INSERT INTO kernel_probe(value) VALUES ($value)"
      ).run({ $value: "persisted-in-opfs" });
      const select = database.prepare(
        "SELECT id, value FROM kernel_probe ORDER BY id"
      );
      const rows = select.all() as Array<{ id: number; value: string }>;
      const version = database.prepare(
        "SELECT sqlite_version() AS version"
      ).get()?.version;
      return {
        sqliteVersion: String(version),
        databasePath: command.databasePath,
        rows,
        columns: select.columns().map((column) => column.name),
        readOnly: false,
        changes: first.changes,
        lastInsertRowid: first.lastInsertRowid
      };
    }

    const select = database.prepare(
      "SELECT id, value FROM kernel_probe ORDER BY id"
    );
    const rows = Array.from(select.iterate()) as Array<{ id: number; value: string }>;
    const version = database.prepare(
      "SELECT sqlite_version() AS version"
    ).get()?.version;
    return {
      sqliteVersion: String(version),
      databasePath: command.databasePath,
      rows,
      columns: select.columns().map((column) => column.name),
      readOnly: true
    };
  } finally {
    database.close();
    sahPool.pauseVfs();
  }
}

self.addEventListener("message", async (event: MessageEvent<ProbeCommand>) => {
  const command = event.data;
  try {
    const evidence = await run(command);
    self.postMessage({ id: command.id, ok: true, evidence } satisfies ProbeResponse);
  } catch (error) {
    self.postMessage(errorResponse(command.id, error));
  }
});
