/// <reference lib="webworker" />

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { createNodeSqliteModule } from "./node-sqlite";
import {
  initializeOpenClawStateContract,
  readOpenClawStateContract,
  type DatabaseContract
} from "./openclaw-sqlite-contract";
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
    initialCapacity: 12,
    name: vfsName
  });
  await sahPool.reserveMinimumCapacity(12);
  const { DatabaseSync } = createNodeSqliteModule(sqlite3, vfsName);
  const database = new DatabaseSync(command.databasePath, {
    readOnly: command.kind === "read"
  });

  try {
    const contractDatabase = database as unknown as DatabaseContract;
    return command.kind === "write"
      ? initializeOpenClawStateContract(contractDatabase, command.databasePath, {
        attachedDatabasePath: command.attachedDatabasePath,
        snapshotDatabasePath: command.snapshotDatabasePath
      })
      : readOpenClawStateContract(contractDatabase, command.databasePath);
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
