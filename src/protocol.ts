import type { OpenClawSqliteEvidence } from "./openclaw-sqlite-contract";

export type ProbeCommand =
  | {
    id: string;
    kind: "write";
    databasePath: string;
    attachedDatabasePath: string;
    snapshotDatabasePath: string;
  }
  | { id: string; kind: "read"; databasePath: string };

export type ProbeEvidence = OpenClawSqliteEvidence;

export type ProbeResponse =
  | { id: string; ok: true; evidence: ProbeEvidence }
  | { id: string; ok: false; error: string; stack?: string };
