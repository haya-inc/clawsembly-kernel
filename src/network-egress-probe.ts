import "./style.css";

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

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

function captureStream(stream: ReadableStream<Uint8Array>): StreamCapture {
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
    } finally {
      finished = true;
      notify();
      reader.releaseLock();
    }
  })();
  return {
    done,
    snapshot: () => captured,
    waitFor: (marker, timeoutMs) => {
      if (captured.includes(marker)) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          cleanup();
          reject(new Error(`Timed out waiting for stream marker: ${marker}`));
        }, timeoutMs);
        const check = () => {
          if (captured.includes(marker)) {
            cleanup();
            resolve();
          } else if (finished) {
            cleanup();
            reject(
              failure
                ?? new Error(`Stream ended before marker: ${marker}`)
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

async function fetchBytes(url: string): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Edge.js WASIX fetch failed with ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

const status = requiredElement<HTMLOutputElement>("#status");
const result = requiredElement<HTMLPreElement>("#result");
const searchParams = new URLSearchParams(location.search);
const artifactUrl = searchParams.get("artifact") ?? "/edgejs.wasm";
const relayUrl =
  searchParams.get("relay") ?? "ws://127.0.0.1:18792/v1/network";
const relayToken = searchParams.get("token");
const fixturePort = 18_791;
const loopbackPort = 18_790;

async function runProbe(): Promise<void> {
  try {
    if (!crossOriginIsolated) {
      throw new Error(
        "Network egress proof requires a cross-origin-isolated context"
      );
    }
    if (!relayToken) throw new Error("The relay capability token is required");

    const { init, initializeLogger, Runtime, runWasix } =
      await import("@wasmer/sdk");
    await init();
    if (searchParams.get("debug") === "1") initializeLogger("debug");
    const runtime = new Runtime({
      registry: null,
      networkEgress: {
        gatewayUrl: relayUrl,
        gatewayToken: relayToken,
        allow: [{
          host: "localhost",
          port: fixturePort,
          allowPrivateNetwork: true
        }]
      }
    } as ConstructorParameters<typeof Runtime>[0]);
    const bytes = await fetchBytes(artifactUrl);
    if (!WebAssembly.validate(bytes)) {
      throw new Error("Chromium rejected the Edge.js WASIX module");
    }
    const module = await WebAssembly.compile(bytes);
    const moduleWithBytes = { module, bytes } as unknown as WebAssembly.Module;

    const runScript = async (script: string): Promise<WasixOutput> => {
      const instance = await runWasix(moduleWithBytes, {
        program: "edgejs",
        args: ["-e", script],
        runtime
      });
      return await instance.wait() as WasixOutput;
    };

    if (searchParams.get("mode") === "http-globals") {
      const prefix = "CLAWSEMBLY_HTTP_GLOBALS=";
      const globals = await runScript([
        "const capture=(operation)=>{try{return {ok:true,value:operation()}}",
        "catch(error){return {ok:false,name:error?.name,message:error?.message,",
        "stack:error?.stack}}};",
        "const target={};",
        "const evidence={",
        "types:{",
        "FinalizationRegistry:typeof FinalizationRegistry,",
        "WeakRef:typeof WeakRef,",
        "queueMicrotask:typeof queueMicrotask,",
        "fetch:typeof fetch",
        "},",
        "finalizationRegistry:capture(()=>{",
        "const value=new FinalizationRegistry(()=>{});",
        "value.register(target,'target');return 'constructed'}),",
        "weakRef:capture(()=>new WeakRef(target).deref()===target),",
        "undici:capture(()=>{",
        "const value=require('internal/deps/undici/undici');",
        "return {fetch:typeof value.fetch,Response:typeof value.Response}",
        "})",
        "};",
        `console.log(${JSON.stringify(prefix)}+JSON.stringify(evidence));`
      ].join(""));
      status.dataset.state = "pass";
      status.textContent = "PASS · Edge.js HTTP runtime globals inspected";
      result.textContent = JSON.stringify({
        schemaVersion: 1,
        status: "http-globals-inspected",
        output: globals
      }, null, 2);
      return;
    }

    if (searchParams.get("mode") === "http-fetch-diagnostic") {
      const prefix = "CLAWSEMBLY_HTTP_FETCH_DIAGNOSTIC=";
      const diagnosticInstance = await runWasix(moduleWithBytes, {
        program: "edgejs",
        args: ["-e", [
          `const prefix=${JSON.stringify(prefix)};`,
          `fetch('http://localhost:${fixturePort}/fixture-http')`,
          ".then(async(response)=>({",
          "ok:response.ok,status:response.status,body:await response.text()",
          "}))",
          ".then(value=>console.log(prefix+JSON.stringify({ok:true,value})))",
          ".catch(error=>console.log(prefix+JSON.stringify({",
          "ok:false,name:error?.name,message:error?.message,stack:error?.stack,",
          "causeName:error?.cause?.name,causeMessage:error?.cause?.message,",
          "causeStack:error?.cause?.stack",
          "})));",
          "setTimeout(()=>console.log(prefix+JSON.stringify({",
          "ok:false,name:'DiagnosticTimeout'",
          "})),30000);"
        ].join("")],
        runtime
      });
      const stdout = captureStream(diagnosticInstance.stdout);
      const stderr = captureStream(diagnosticInstance.stderr);
      await Promise.any([
        stdout.waitFor(prefix, 35_000),
        stderr.waitFor(prefix, 35_000)
      ]);
      status.dataset.state = "pass";
      status.textContent = "PASS · Edge.js HTTP fetch crossed exact egress";
      result.textContent = JSON.stringify({
        schemaVersion: 1,
        status: "http-fetch-pass",
        stdout: stdout.snapshot(),
        stderr: stderr.snapshot()
      }, null, 2);
      return;
    }

    status.textContent = "Proving browser-local loopback remains local…";
    const listeningMarker = "CLAWSEMBLY_EGRESS_LOOPBACK_LISTENING";
    const serverMarker = "CLAWSEMBLY_EGRESS_LOOPBACK_SERVER=ping:pong";
    const clientMarker = "CLAWSEMBLY_EGRESS_LOOPBACK_CLIENT=pong";
    const serverInstance = await runWasix(moduleWithBytes, {
      program: "edgejs",
      args: ["-e", [
        "const net=require('node:net');",
        `const server=net.createServer((socket)=>{`,
        "let request='';socket.setEncoding('utf8');",
        "socket.on('data',(chunk)=>{request+=chunk;",
        "if(request==='ping')socket.end('pong')});",
        "socket.on('close',()=>server.close(()=>{",
        `console.log(${JSON.stringify(serverMarker)});`,
        "clearTimeout(watchdog);process.exit(0)}));",
        "});",
        "server.on('error',(error)=>{console.error(error);process.exit(1)});",
        `server.listen(${loopbackPort},'127.0.0.1',()=>`,
        `{console.log(${JSON.stringify(listeningMarker)})});`,
        "const watchdog=setTimeout(()=>process.exit(124),20000);"
      ].join("")],
      runtime
    });
    const serverStdout = captureStream(serverInstance.stdout);
    const serverStderr = captureStream(serverInstance.stderr);
    const serverExit = serverInstance.wait() as Promise<WasixOutput>;
    await serverStdout.waitFor(listeningMarker, 20_000);
    const loopbackClient = await runScript([
      "const net=require('node:net');let response='';",
      `const socket=net.createConnection({host:'127.0.0.1',port:${loopbackPort}});`,
      "socket.setEncoding('utf8');",
      "socket.on('connect',()=>socket.write('ping'));",
      "socket.on('data',(chunk)=>response+=chunk);",
      "socket.on('end',()=>{if(response!=='pong')process.exit(2);",
      `console.log(${JSON.stringify(clientMarker)});`,
      "clearTimeout(watchdog);process.exit(0)});",
      "socket.on('error',(error)=>{console.error(error);process.exit(1)});",
      "const watchdog=setTimeout(()=>process.exit(124),20000);"
    ].join(""));
    const serverResult = await serverExit;
    await Promise.all([serverStdout.done, serverStderr.done]);
    const loopbackServer: WasixOutput = {
      ...serverResult,
      stdout: serverStdout.snapshot(),
      stderr: serverStderr.snapshot()
    };
    if (
      !loopbackClient.ok
      || !loopbackServer.ok
      || !loopbackClient.stdout.includes(clientMarker)
      || !loopbackServer.stdout.includes(serverMarker)
    ) {
      throw new Error(
        "Browser-local loopback regressed: "
        + JSON.stringify({ loopbackClient, loopbackServer })
      );
    }

    status.textContent = "Proving the exact granted host and port…";
    const authorizedMarker = "CLAWSEMBLY_EGRESS_AUTHORIZED=egress-pong";
    const authorized = await runScript([
      "const net=require('node:net');let response='';",
      `const socket=net.createConnection({host:'localhost',`,
      `port:${fixturePort}});`,
      "socket.setEncoding('utf8');",
      "socket.on('connect',()=>socket.write('egress-ping'));",
      "socket.on('data',(chunk)=>response+=chunk);",
      "socket.on('end',()=>{if(response!=='egress-pong')process.exit(2);",
      `console.log(${JSON.stringify(authorizedMarker)});`,
      "clearTimeout(watchdog);process.exit(0)});",
      "socket.on('error',(error)=>{console.error(error);process.exit(1)});",
      "const watchdog=setTimeout(()=>process.exit(124),30000);"
    ].join(""));
    if (!authorized.ok || !authorized.stdout.includes(authorizedMarker)) {
      throw new Error(
        "Granted egress did not cross the relay: " + JSON.stringify(authorized)
      );
    }

    status.textContent = "Proving ungranted authority is denied…";
    const denialCompleteMarker = "CLAWSEMBLY_EGRESS_DENIAL_SUITE=complete";
    const denialInstance = await runWasix(moduleWithBytes, {
      program: "edgejs",
      args: ["-e", [
        "const net=require('node:net');",
        "const attempt=(label,options)=>new Promise((resolve,reject)=>{",
        "let settled=false;let socket;",
        "const timeout=setTimeout(()=>{",
        "if(settled)return;settled=true;",
        "reject(new Error('denial timeout:'+label))",
        "},10000);",
        "const denied=(error)=>{if(settled)return;settled=true;",
        "clearTimeout(timeout);",
        "console.log('CLAWSEMBLY_EGRESS_DENIED:'+label+':'",
        "+(error?.code??error?.name??'unknown'));",
        "socket?.destroy();resolve()};",
        "try{socket=net.createConnection(options)}catch(error){",
        "denied(error);return}",
        "socket.once('connect',()=>{if(settled)return;settled=true;",
        "clearTimeout(timeout);socket.destroy();",
        "reject(new Error('unexpected connection:'+label))});",
        "socket.once('error',denied)",
        "});",
        "(async()=>{try{",
        "await attempt('wrong-port',{host:'localhost',port:18793});",
        "await attempt('unlisted-host',{host:'example.com',port:443});",
        "await attempt('raw-ip',{host:'1.1.1.1',port:443});",
        `console.log(${JSON.stringify(denialCompleteMarker)});`,
        "clearTimeout(watchdog);process.exit(0)",
        "}catch(error){console.error(error?.stack??String(error));",
        "clearTimeout(watchdog);process.exit(2)}})();",
        "const watchdog=setTimeout(()=>{",
        "console.error('denial suite watchdog');process.exit(124)",
        "},40000);"
      ].join("")],
      runtime
    });
    const denialStdout = captureStream(denialInstance.stdout);
    const denialStderr = captureStream(denialInstance.stderr);
    await denialStdout.waitFor(denialCompleteMarker, 45_000);
    const denialStdoutSnapshot = denialStdout.snapshot();
    const denialStderrSnapshot = denialStderr.snapshot();
    const denialLabels = {
      wrongPort: "wrong-port",
      unlistedHost: "unlisted-host",
      rawIp: "raw-ip"
    } as const;
    const denials = Object.fromEntries(
      Object.entries(denialLabels).map(([key, label]) => [
        key,
        {
          code: null,
          completion: "explicit-error-marker-observed",
          ok: true,
          stderr: denialStderrSnapshot,
          stdout: denialStdoutSnapshot
            .split(/\r?\n/u)
            .filter((line) => line.startsWith(
              `CLAWSEMBLY_EGRESS_DENIED:${label}:`
            ))
            .join("\n") + "\n"
        }
      ])
    );
    for (const [label, output] of Object.entries(denials)) {
      if (
        !output.stdout.includes(
          `CLAWSEMBLY_EGRESS_DENIED:${label.replace(/[A-Z]/gu, (value) =>
            `-${value.toLowerCase()}`)}:`
        )
      ) {
        throw new Error(
          `Ungrantable egress was not explicitly denied (${label}): `
          + JSON.stringify(output)
        );
      }
    }

    const evidence = {
      schemaVersion: 1,
      status: "capability-egress-pass",
      crossOriginIsolated,
      artifactBytes: bytes.byteLength,
      network: {
        namespace: "browser-local-loopback+capability-egress",
        loopback: {
          host: "127.0.0.1",
          port: loopbackPort,
          request: "ping",
          response: "pong",
          server: loopbackServer,
          client: loopbackClient
        },
        egress: {
          transport: "self-hosted-virtual-net-websocket-relay",
          relayUrl,
          credentialTransport: "Sec-WebSocket-Protocol",
          tokenRecorded: false,
          allow: [{
            host: "localhost",
            port: fixturePort,
            allowPrivateNetwork: true
          }],
          authorized,
          denied: denials
        }
      }
    };
    status.dataset.state = "pass";
    status.textContent = "PASS · capability-scoped browser egress";
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
