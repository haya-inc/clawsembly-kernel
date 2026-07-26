export type ProbeCommand =
  | { id: string; kind: "write"; databasePath: string }
  | { id: string; kind: "read"; databasePath: string };

export type ProbeEvidence = {
  sqliteVersion: string;
  databasePath: string;
  rows: Array<{ id: number; value: string }>;
  columns: string[];
  readOnly: boolean;
  changes?: number;
  lastInsertRowid?: number | bigint;
};

export type ProbeResponse =
  | { id: string; ok: true; evidence: ProbeEvidence }
  | { id: string; ok: false; error: string; stack?: string };
