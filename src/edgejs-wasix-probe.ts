import "./style.css";

type EdgeVersions = {
  edge: string;
  node: string;
  v8: string;
};

type WasixOutput = {
  code: number;
  ok: boolean;
  stderr: string;
  stdout: string;
};

type SqliteMarker = {
  checkpointed: number;
  count: number;
  extensionLoadingRejected: boolean;
  foreignKeys: number;
  journalMode: string;
  phase: "read" | "write";
  version: string;
};

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

const status = requiredElement<HTMLOutputElement>("#status");
const result = requiredElement<HTMLPreElement>("#result");
const searchParams = new URLSearchParams(location.search);
const artifactUrl = searchParams.get("artifact")
  ?? "/edgejs.wasm";
const marker = "clawsembly-edgejs-wasix-browser";
const markerPrefix = "CLAWSEMBLY_EDGE_WASIX=";
const sqliteMarkerPrefix = "CLAWSEMBLY_EDGE_SQLITE=";

function markerPayload<T>(
  output: WasixOutput,
  prefix: string
): T {
  const line = output.stdout
    .split(/\r?\n/u)
    .find((candidate) => candidate.startsWith(prefix));
  if (!line) {
    throw new Error(`Edge.js emitted no ${prefix} marker: ${output.stdout}`);
  }
  return JSON.parse(line.slice(prefix.length)) as T;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function runProbe(): Promise<void> {
  try {
    if (!crossOriginIsolated) {
      throw new Error("Edge.js WASIX requires a cross-origin-isolated browser context");
    }
    const { Directory, init, initializeLogger, runWasix } =
      await import("@wasmer/sdk");
    await init();
    if (searchParams.get("debug") === "1") initializeLogger("debug");
    status.textContent = "Fetching the self-built Edge.js WASIX artifact…";
    const response = await fetch(artifactUrl);
    if (!response.ok) {
      throw new Error(`Edge.js WASIX fetch failed with ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!WebAssembly.validate(bytes)) {
      throw new Error("Chromium rejected the Edge.js WASIX module");
    }
    const module = await WebAssembly.compile(bytes);
    status.textContent = "Starting Edge.js inside the browser…";
    const runtimeScript = [
      `console.log(${JSON.stringify(markerPrefix)} + JSON.stringify({`,
      `marker: ${JSON.stringify(marker)},`,
      "edge: process.versions.edge,",
      "node: process.versions.node,",
      "v8: process.versions.v8",
      "}))"
    ].join("");
    const moduleWithBytes = { module, bytes } as unknown as WebAssembly.Module;
    const instance = await runWasix(moduleWithBytes, {
      program: "edgejs",
      args: ["-e", runtimeScript]
    });
    const output = await instance.wait();
    if (!output.ok) {
      throw new Error(
        `Edge.js WASIX exited with ${output.code}: ${output.stderr || output.stdout}`
      );
    }
    const runtime = markerPayload<
      EdgeVersions & { marker: string }
    >(output as WasixOutput, markerPrefix);
    if (runtime.marker !== marker) {
      throw new Error(`Unexpected Edge.js marker: ${runtime.marker}`);
    }

    status.textContent = "Verifying synchronous process.exit() semantics…";
    const exitInstance = await runWasix(moduleWithBytes, {
      program: "edgejs",
      args: [
        "-e",
        [
          'console.log("before-exit")',
          "process.exit(7)",
          'console.log("after-exit")'
        ].join(";")
      ]
    });
    const processExit = await exitInstance.wait() as WasixOutput;
    if (
      processExit.code !== 7
      || processExit.stdout !== "before-exit\n"
      || processExit.stderr !== ""
    ) {
      throw new Error(
        "Edge.js process.exit() semantics mismatch: "
        + JSON.stringify(processExit)
      );
    }

    status.textContent =
      "Verifying SQLite 3.53.4, WAL, and cross-process persistence…";
    const sqliteDirectory = new Directory();
    const sqliteWriteScript = [
      `const prefix=${JSON.stringify(sqliteMarkerPrefix)};`,
      "const {DatabaseSync}=require('node:sqlite');",
      "const db=new DatabaseSync('/state/openclaw-state.db',{timeout:1000});",
      "const version=db.prepare(",
      "'SELECT sqlite_version() AS version').get().version;",
      "const foreignKeys=db.prepare('PRAGMA foreign_keys').get().foreign_keys;",
      "const journalMode=db.prepare(",
      "'PRAGMA journal_mode = WAL').get().journal_mode;",
      "db.exec(",
      "'CREATE TABLE turns(id INTEGER PRIMARY KEY, body TEXT NOT NULL);'",
      ");",
      "db.exec('BEGIN IMMEDIATE');",
      "db.prepare('INSERT INTO turns(body) VALUES ($body)')",
      ".run({$body:'first'});",
      "db.exec('SAVEPOINT nested');",
      "db.prepare('INSERT INTO turns(body) VALUES (?)').run('rolled-back');",
      "db.exec('ROLLBACK TO nested; RELEASE nested; COMMIT');",
      "db.enableLoadExtension(false);",
      "let extensionLoadingRejected=false;",
      "try{db.enableLoadExtension(true)}catch(error){",
      "extensionLoadingRejected=error?.code==='ERR_FEATURE_UNAVAILABLE'",
      "}",
      "const checkpoint=db.prepare(",
      "'PRAGMA wal_checkpoint(TRUNCATE)').get();",
      "const count=db.prepare('SELECT count(*) AS count FROM turns')",
      ".get().count;",
      "db.close();",
      "console.log(prefix+JSON.stringify({",
      "phase:'write',version,foreignKeys,journalMode,count,",
      "checkpointed:checkpoint.checkpointed,extensionLoadingRejected",
      "}));"
    ].join("");
    const sqliteWriteInstance = await runWasix(moduleWithBytes, {
      program: "edgejs",
      args: ["-e", sqliteWriteScript],
      mount: { "/state": sqliteDirectory }
    });
    const sqliteWrite = await sqliteWriteInstance.wait() as WasixOutput;
    if (!sqliteWrite.ok) {
      throw new Error(
        `Edge.js SQLite write probe exited with ${sqliteWrite.code}: `
        + `${sqliteWrite.stderr || sqliteWrite.stdout}`
      );
    }
    const sqliteWriteMarker =
      markerPayload<SqliteMarker>(sqliteWrite, sqliteMarkerPrefix);

    const sqliteReadScript = [
      `const prefix=${JSON.stringify(sqliteMarkerPrefix)};`,
      "const {DatabaseSync}=require('node:sqlite');",
      "const db=new DatabaseSync('/state/openclaw-state.db',{readOnly:true});",
      "const version=db.prepare(",
      "'SELECT sqlite_version() AS version').get().version;",
      "const foreignKeys=db.prepare('PRAGMA foreign_keys').get().foreign_keys;",
      "const journalMode=db.prepare('PRAGMA journal_mode').get().journal_mode;",
      "const count=db.prepare('SELECT count(*) AS count FROM turns')",
      ".get().count;",
      "db.close();",
      "console.log(prefix+JSON.stringify({",
      "phase:'read',version,foreignKeys,journalMode,count,checkpointed:0,",
      "extensionLoadingRejected:true",
      "}));"
    ].join("");
    const sqliteReadInstance = await runWasix(moduleWithBytes, {
      program: "edgejs",
      args: ["-e", sqliteReadScript],
      mount: { "/state": sqliteDirectory }
    });
    const sqliteRead = await sqliteReadInstance.wait() as WasixOutput;
    if (!sqliteRead.ok) {
      throw new Error(
        `Edge.js SQLite read probe exited with ${sqliteRead.code}: `
        + `${sqliteRead.stderr || sqliteRead.stdout}`
      );
    }
    const sqliteReadMarker =
      markerPayload<SqliteMarker>(sqliteRead, sqliteMarkerPrefix);
    if (
      sqliteWriteMarker.phase !== "write"
      || sqliteReadMarker.phase !== "read"
      || sqliteWriteMarker.version !== "3.53.4"
      || sqliteReadMarker.version !== "3.53.4"
      || sqliteWriteMarker.foreignKeys !== 1
      || sqliteReadMarker.foreignKeys !== 1
      || sqliteWriteMarker.journalMode !== "wal"
      || sqliteReadMarker.journalMode !== "wal"
      || sqliteWriteMarker.count !== 1
      || sqliteReadMarker.count !== 1
      || !sqliteWriteMarker.extensionLoadingRejected
    ) {
      throw new Error(
        "Edge.js SQLite contract mismatch: "
        + JSON.stringify({ sqliteWriteMarker, sqliteReadMarker })
      );
    }
    const sqliteDatabase = await sqliteDirectory.readFile(
      "openclaw-state.db"
    );

    const evidence = {
      schemaVersion: 1,
      status: "pass",
      crossOriginIsolated,
      executor: "@wasmer/sdk",
      artifactBytes: bytes.byteLength,
      runtime,
      exitCode: output.code,
      stderr: output.stderr,
      processExit,
      sqlite: {
        version: sqliteWriteMarker.version,
        databaseBytes: sqliteDatabase.byteLength,
        databaseSha256: await sha256(sqliteDatabase),
        write: {
          marker: sqliteWriteMarker,
          result: sqliteWrite
        },
        crossProcessRead: {
          marker: sqliteReadMarker,
          result: sqliteRead
        }
      }
    };
    status.dataset.state = "pass";
    status.textContent = "PASS · Edge.js started inside the browser";
    result.textContent = JSON.stringify(evidence, null, 2);
  } catch (error) {
    status.dataset.state = "fail";
    status.textContent = "FAIL";
    result.textContent = error instanceof Error
      ? `${error.message}\n${error.stack ?? ""}`
      : String(error);
  }
}

void runProbe();
