import { expect, test } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  initializeOpenClawStateContract,
  readOpenClawStateContract,
  type DatabaseContract,
  type OpenClawSqliteEvidence
} from "../src/openclaw-sqlite-contract";

function signature(evidence: OpenClawSqliteEvidence) {
  return {
    artifact: evidence.artifact,
    minimumSafeSqliteVersion: evidence.minimumSafeSqliteVersion,
    stateSchema: evidence.stateSchema,
    journalMode: evidence.pragmas.journalMode,
    storageOperations: evidence.storageOperations
  };
}

test("official OpenClaw state contract matches native Node and persists in OPFS", async ({
  page
}) => {
  const nativeDirectory = await mkdtemp(path.join(tmpdir(), "clawsembly-native-contract-"));
  const nativePath = path.join(nativeDirectory, "openclaw-state.sqlite3");
  const nativeAttachedPath = path.join(nativeDirectory, "attached.sqlite3");
  const nativeSnapshotPath = path.join(nativeDirectory, "snapshot.sqlite3");
  try {
    const nativeWriteDatabase = new DatabaseSync(nativePath);
    const nativeWrite = initializeOpenClawStateContract(
      nativeWriteDatabase as unknown as DatabaseContract,
      nativePath,
      {
        attachedDatabasePath: nativeAttachedPath,
        snapshotDatabasePath: nativeSnapshotPath
      }
    );
    nativeWriteDatabase.close();
    const nativeReadDatabase = new DatabaseSync(nativePath, { readOnly: true });
    const nativeRead = readOpenClawStateContract(
      nativeReadDatabase as unknown as DatabaseContract,
      nativePath
    );
    nativeReadDatabase.close();

    await page.goto("/");
    await expect(page.locator("#status")).toHaveAttribute("data-state", "pass", {
      timeout: 30_000
    });
    await expect(page.locator("#status")).toHaveText(
      "PASS · official OpenClaw state persisted"
    );

    const evidence = JSON.parse(
      await page.locator("#result").textContent() ?? "{}"
    ) as {
      status: string;
      crossOriginIsolated: boolean;
      workerGenerations: number;
      write: OpenClawSqliteEvidence;
      read: OpenClawSqliteEvidence;
    };
    expect(evidence).toMatchObject({
      status: "pass",
      crossOriginIsolated: true,
      workerGenerations: 2,
      write: {
        readOnly: false,
        pragmas: {
          journalMode: "wal",
          lockingMode: "exclusive"
        },
        transaction: {
          rows: ["outer", "released"],
          rolledBackRowAbsent: true
        },
        storageOperations: {
          attachedValue: "attached",
          snapshotTables: 73,
          snapshotIndexes: 103,
          snapshotPrimaryRole: "global"
        }
      },
      read: {
        readOnly: true,
        pragmas: {
          journalMode: "wal",
          lockingMode: "exclusive"
        },
        stateSchema: {
          sha256: "290198b5e8fb37f5b4a43fcce041bb91d0c1e23a8cc9730144b138f436e34093",
          tables: 73,
          indexes: 103,
          userVersion: 1
        }
      }
    });
    expect(nativeWrite.pragmas.lockingMode).toBe("normal");
    expect(nativeRead.pragmas.lockingMode).toBe("normal");
    expect(signature(evidence.write)).toEqual(signature(nativeWrite));
    expect(signature(evidence.read)).toEqual(signature(nativeRead));
    expect(evidence.read.sqliteVersion).toMatch(/^3\.53\./);
  } finally {
    await rm(nativeDirectory, { recursive: true, force: true });
  }
});
