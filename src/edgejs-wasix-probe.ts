import "./style.css";

type EdgeVersions = {
  edge: string;
  node: string;
  v8: string;
};

type EventLoopMarker = {
  elapsedMs: number;
  timerKeepAlive: boolean;
};

type WasixOutput = {
  code: number;
  ok: boolean;
  stderr: string;
  stdout: string;
};

type StreamCapture = {
  done: Promise<void>;
  snapshot: () => string;
  waitFor: (marker: string, timeoutMs: number) => Promise<void>;
};

type SqliteMarker = {
  checkpointed: number;
  count: number;
  extensionLoadingRejected: boolean;
  foreignKeys: number;
  journalMode: string;
  lockingMode: string;
  overlappingConnections?: boolean;
  overlappingReadOnlyConnection?: boolean;
  phase: "read" | "write";
  readOnlyExecRejected?: boolean;
  readOnlyPrepareRejected?: boolean;
  statementFinalized: boolean;
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
const browserCpuThrottlingRate = Number(
  searchParams.get("cpuThrottleRate") ?? "1"
);
const marker = "clawsembly-edgejs-wasix-browser";
const markerPrefix = "CLAWSEMBLY_EDGE_WASIX=";
const eventLoopMarkerPrefix = "CLAWSEMBLY_EDGE_EVENT_LOOP=";
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

function captureStream(
  stream: ReadableStream<Uint8Array>
): StreamCapture {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const waiters = new Set<() => void>();
  let captured = "";
  let failure: unknown;
  let finished = false;
  const notify = () => {
    for (const waiter of [...waiters]) waiter();
  };
  const done = (async () => {
    try {
      for (;;) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        captured += decoder.decode(value, { stream: true });
        notify();
      }
      captured += decoder.decode();
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      finished = true;
      notify();
      reader.releaseLock();
    }
  })();
  return {
    done,
    snapshot: () => captured,
    waitFor: (expectedMarker, timeoutMs) => {
      if (captured.includes(expectedMarker)) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          cleanup();
          reject(
            new Error(
              `Timed out waiting for stream marker: ${expectedMarker}`
            )
          );
        }, timeoutMs);
        const check = () => {
          if (captured.includes(expectedMarker)) {
            cleanup();
            resolve();
          } else if (finished) {
            cleanup();
            reject(
              failure
                ?? new Error(
                  `Stream ended before marker: ${expectedMarker}`
                )
            );
          }
        };
        const cleanup = () => {
          window.clearTimeout(timeout);
          waiters.delete(check);
        };
        waiters.add(check);
      });
    }
  };
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
    if (
      !Number.isInteger(browserCpuThrottlingRate)
      || browserCpuThrottlingRate < 1
      || browserCpuThrottlingRate > 100
    ) {
      throw new Error(
        `Invalid browser CPU throttling rate: ${browserCpuThrottlingRate}`
      );
    }
    if (!crossOriginIsolated) {
      throw new Error("Edge.js WASIX requires a cross-origin-isolated browser context");
    }
    const { Directory, init, initializeLogger, Runtime, runWasix } =
      await import("@wasmer/sdk");
    await init();
    const wasixRuntime = new Runtime({ registry: null });
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
      args: ["-e", runtimeScript],
      runtime: wasixRuntime
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

    status.textContent =
      "Verifying that a refed timer keeps the Node event loop alive…";
    const eventLoopScript = [
      `const prefix=${JSON.stringify(eventLoopMarkerPrefix)};`,
      "const started=Date.now();",
      "setTimeout(()=>{",
      "console.log(prefix+JSON.stringify({",
      "elapsedMs:Date.now()-started,timerKeepAlive:true",
      "}))",
      "},50)"
    ].join("");
    const eventLoopInstance = await runWasix(moduleWithBytes, {
      program: "edgejs",
      args: ["-e", eventLoopScript],
      runtime: wasixRuntime
    });
    const eventLoopOutput =
      await eventLoopInstance.wait() as WasixOutput;
    if (!eventLoopOutput.ok) {
      throw new Error(
        "Edge.js timer keep-alive probe failed: "
        + JSON.stringify(eventLoopOutput)
      );
    }
    const eventLoop = markerPayload<EventLoopMarker>(
      eventLoopOutput,
      eventLoopMarkerPrefix
    );
    if (!eventLoop.timerKeepAlive || eventLoop.elapsedMs < 40) {
      throw new Error(
        "Edge.js exited before its refed timer fired: "
        + JSON.stringify({ eventLoop, eventLoopOutput })
      );
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
      ],
      runtime: wasixRuntime
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
      "const lockingMode=db.prepare(",
      "'PRAGMA locking_mode').get().locking_mode;",
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
      "const overlapping=new DatabaseSync(",
      "'/state/openclaw-state.db',{timeout:1000});",
      "overlapping.exec('BEGIN IMMEDIATE');",
      "const overlappingCount=overlapping.prepare(",
      "'SELECT count(*) AS count FROM turns').get().count;",
      "overlapping.exec('COMMIT');",
      "overlapping.close();",
      "const overlappingReadOnly=new DatabaseSync(",
      "'/state/openclaw-state.db',{readOnly:true,timeout:1000});",
      "const overlappingReadOnlyCount=overlappingReadOnly.prepare(",
      "'SELECT count(*) AS count FROM turns').get().count;",
      "let readOnlyPrepareRejected=false;",
      "try{overlappingReadOnly.prepare(",
      "'INSERT INTO turns(body) VALUES (\\'forbidden-prepare\\')')",
      "}catch(error){",
      "readOnlyPrepareRejected=error?.code==='ERR_SQLITE_READONLY'",
      "}",
      "let readOnlyExecRejected=false;",
      "try{overlappingReadOnly.exec(",
      "'INSERT INTO turns(body) VALUES (\\'forbidden-exec\\')')",
      "}catch(error){",
      "readOnlyExecRejected=error?.code==='ERR_SQLITE_READONLY'",
      "}",
      "overlappingReadOnly.close();",
      "const longLivedCount=db.prepare(",
      "'SELECT count(*) AS count FROM turns').get().count;",
      "const overlappingConnections=",
      "overlappingCount===1&&longLivedCount===1;",
      "const overlappingReadOnlyConnection=",
      "overlappingReadOnlyCount===1&&longLivedCount===1;",
      "db.enableLoadExtension(false);",
      "let extensionLoadingRejected=false;",
      "try{db.enableLoadExtension(true)}catch(error){",
      "extensionLoadingRejected=error?.code==='ERR_FEATURE_UNAVAILABLE'",
      "}",
      "const checkpoint=db.prepare(",
      "'PRAGMA wal_checkpoint(TRUNCATE)').get();",
      "const retained=db.prepare('SELECT count(*) AS count FROM turns');",
      "const count=retained.get().count;",
      "db.close();",
      "let statementFinalized=false;",
      "try{retained.get()}catch(error){",
      "statementFinalized=error?.code==='ERR_INVALID_STATE'",
      "}",
      "console.log(prefix+JSON.stringify({",
      "phase:'write',version,foreignKeys,lockingMode,journalMode,count,",
      "checkpointed:checkpoint.checkpointed,extensionLoadingRejected,",
      "overlappingConnections,overlappingReadOnlyConnection,",
      "readOnlyPrepareRejected,readOnlyExecRejected,statementFinalized",
      "}));"
    ].join("");
    const sqliteWriteInstance = await runWasix(moduleWithBytes, {
      program: "edgejs",
      args: ["-e", sqliteWriteScript],
      mount: { "/state": sqliteDirectory },
      runtime: wasixRuntime
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
      "const lockingMode=db.prepare(",
      "'PRAGMA locking_mode').get().locking_mode;",
      "const version=db.prepare(",
      "'SELECT sqlite_version() AS version').get().version;",
      "const foreignKeys=db.prepare('PRAGMA foreign_keys').get().foreign_keys;",
      "const journalMode=db.prepare('PRAGMA journal_mode').get().journal_mode;",
      "const retained=db.prepare('SELECT count(*) AS count FROM turns');",
      "const count=retained.get().count;",
      "db.close();",
      "let statementFinalized=false;",
      "try{retained.get()}catch(error){",
      "statementFinalized=error?.code==='ERR_INVALID_STATE'",
      "}",
      "console.log(prefix+JSON.stringify({",
      "phase:'read',version,foreignKeys,lockingMode,journalMode,count,",
      "checkpointed:0,",
      "extensionLoadingRejected:true,statementFinalized",
      "}));"
    ].join("");
    const sqliteReadInstance = await runWasix(moduleWithBytes, {
      program: "edgejs",
      args: ["-e", sqliteReadScript],
      mount: { "/state": sqliteDirectory },
      runtime: wasixRuntime
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
      || sqliteWriteMarker.lockingMode !== "exclusive"
      || sqliteReadMarker.lockingMode !== "exclusive"
      || sqliteWriteMarker.journalMode !== "wal"
      || sqliteReadMarker.journalMode !== "wal"
      || sqliteWriteMarker.count !== 1
      || sqliteReadMarker.count !== 1
      || !sqliteWriteMarker.extensionLoadingRejected
      || !sqliteWriteMarker.overlappingConnections
      || !sqliteWriteMarker.overlappingReadOnlyConnection
      || !sqliteWriteMarker.readOnlyPrepareRejected
      || !sqliteWriteMarker.readOnlyExecRejected
      || !sqliteWriteMarker.statementFinalized
      || !sqliteReadMarker.statementFinalized
    ) {
      throw new Error(
        "Edge.js SQLite contract mismatch: "
        + JSON.stringify({ sqliteWriteMarker, sqliteReadMarker })
      );
    }
    const sqliteDatabase = await sqliteDirectory.readFile(
      "openclaw-state.db"
    );

    status.textContent =
      "Verifying capability-scoped TCP across browser guest processes…";
    const loopbackPort = 18_790;
    const loopbackListeningMarker = "CLAWSEMBLY_LOOPBACK_LISTENING";
    const loopbackServerMarker = "CLAWSEMBLY_LOOPBACK_SERVER=ping:pong";
    const loopbackClientMarker = "CLAWSEMBLY_LOOPBACK_CLIENT=pong";
    const loopbackServerScript = [
      "const net=require('node:net');",
      `const port=${loopbackPort};`,
      "const server=net.createServer((socket)=>{",
      "console.log('CLAWSEMBLY_LOOPBACK_SERVER_ACCEPTED');",
      "let request='';",
      "let responded=false;",
      "socket.setEncoding('utf8');",
      "socket.on('data',(chunk)=>{",
      "console.log('CLAWSEMBLY_LOOPBACK_SERVER_DATA='+chunk);",
      "request+=chunk;",
      "if(request==='ping'){responded=true;socket.end('pong')}",
      "});",
      "socket.on('end',()=>{",
      "console.log('CLAWSEMBLY_LOOPBACK_SERVER_END')",
      "});",
      "socket.on('close',(hadError)=>{",
      "console.log('CLAWSEMBLY_LOOPBACK_SERVER_CLOSE='+hadError);",
      "if(!responded){console.error('unexpected request:'+request);",
      "process.exit(2);return}",
      "server.close(()=>{",
      `console.log(${JSON.stringify(loopbackServerMarker)});`,
      "clearTimeout(watchdog);process.exit(0)",
      "})",
      "})",
      "});",
      "server.on('error',(error)=>{console.error(error);process.exit(1)});",
      "server.listen(port,'127.0.0.1',()=>{",
      `console.log(${JSON.stringify(loopbackListeningMarker)});`,
      "});",
      "const watchdog=setTimeout(()=>{",
      "console.error('loopback server timeout');process.exit(124)",
      "},30000);"
    ].join("");
    const loopbackServerInstance = await runWasix(moduleWithBytes, {
      program: "edgejs",
      args: ["-e", loopbackServerScript],
      runtime: wasixRuntime
    });
    const loopbackServerStdout =
      captureStream(loopbackServerInstance.stdout);
    const loopbackServerStderr =
      captureStream(loopbackServerInstance.stderr);
    const loopbackServerExit =
      loopbackServerInstance.wait() as Promise<WasixOutput>;
    await loopbackServerStdout.waitFor(
      loopbackListeningMarker,
      30_000
    );

    const loopbackClientScript = [
      "const net=require('node:net');",
      "let response='';",
      "const socket=net.createConnection({",
      `host:'127.0.0.1',port:${loopbackPort}`,
      "});",
      "socket.setEncoding('utf8');",
      "socket.on('connect',()=>{",
      "console.log('CLAWSEMBLY_LOOPBACK_CLIENT_CONNECTED');",
      "const accepted=socket.write('ping',()=>{",
      "console.log('CLAWSEMBLY_LOOPBACK_CLIENT_WROTE')",
      "});",
      "console.log('CLAWSEMBLY_LOOPBACK_CLIENT_WRITE_ACCEPTED='+accepted);",
      "});",
      "socket.on('data',(chunk)=>{",
      "console.log('CLAWSEMBLY_LOOPBACK_CLIENT_DATA='+chunk);",
      "response+=chunk",
      "});",
      "socket.on('end',()=>{",
      "if(response!=='pong'){console.error('unexpected response:'+response);",
      "process.exit(2);return}",
      `console.log(${JSON.stringify(loopbackClientMarker)});`,
      "clearTimeout(watchdog);process.exit(0)",
      "});",
      "socket.on('error',(error)=>{console.error(error);process.exit(1)});",
      "const watchdog=setTimeout(()=>{",
      "console.error('loopback client timeout');process.exit(124)",
      "},20000);"
    ].join("");
    const loopbackClientInstance = await runWasix(moduleWithBytes, {
      program: "edgejs",
      args: ["-e", loopbackClientScript],
      runtime: wasixRuntime
    });
    const loopbackClient =
      await loopbackClientInstance.wait() as WasixOutput;
    const loopbackServerResult = await loopbackServerExit;
    await Promise.all([
      loopbackServerStdout.done,
      loopbackServerStderr.done
    ]);
    const loopbackServer: WasixOutput = {
      ...loopbackServerResult,
      stdout: loopbackServerStdout.snapshot(),
      stderr: loopbackServerStderr.snapshot()
    };
    if (
      !loopbackServer.ok
      || !loopbackClient.ok
      || !loopbackServer.stdout.includes(loopbackServerMarker)
      || !loopbackClient.stdout.includes(loopbackClientMarker)
    ) {
      throw new Error(
        "Browser-local loopback contract mismatch: "
        + JSON.stringify({ loopbackClient, loopbackServer })
      );
    }
    const externalDeniedMarker = "CLAWSEMBLY_EXTERNAL_EGRESS=denied:";
    const externalDeniedScript = [
      "const net=require('node:net');",
      "let watchdog;",
      "const denied=(error)=>{",
      `console.log(${JSON.stringify(externalDeniedMarker)}`,
      "+(error?.code??error?.name??'unknown'));",
      "clearTimeout(watchdog);process.exit(0)",
      "};",
      "let socket;",
      "try{socket=net.createConnection({host:'1.1.1.1',port:80})}",
      "catch(error){denied(error)}",
      "socket?.on('connect',()=>{",
      "console.error('external egress unexpectedly connected');",
      "process.exit(2)",
      "});",
      "socket?.on('error',denied);",
      "watchdog=setTimeout(()=>{",
      "console.error('external denial timeout');process.exit(124)",
      "},10000);"
    ].join("");
    const externalDeniedInstance = await runWasix(moduleWithBytes, {
      program: "edgejs",
      args: ["-e", externalDeniedScript],
      runtime: wasixRuntime
    });
    const externalDenied =
      await externalDeniedInstance.wait() as WasixOutput;
    if (
      !externalDenied.ok
      || !externalDenied.stdout.includes(externalDeniedMarker)
    ) {
      throw new Error(
        "External egress capability was not denied explicitly: "
        + JSON.stringify(externalDenied)
      );
    }

    const evidence = {
      schemaVersion: 1,
      status: "pass",
      crossOriginIsolated,
      executor: "@wasmer/sdk",
      artifactBytes: bytes.byteLength,
      runtime,
      eventLoop,
      exitCode: output.code,
      stderr: output.stderr,
      processExit,
      network: {
        namespace: "browser-local-loopback",
        listenHost: "127.0.0.1",
        port: loopbackPort,
        externalEgress: {
          status: "denied-by-default",
          result: externalDenied
        },
        request: "ping",
        response: "pong",
        schedulerStress: {
          browserCpuThrottlingRate
        },
        server: loopbackServer,
        client: loopbackClient
      },
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
