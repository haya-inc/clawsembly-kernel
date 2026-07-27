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

    const denialScript = (
      label: string,
      connection: string
    ): string => [
      "const net=require('node:net');let settled=false;",
      "const denied=(error)=>{if(settled)return;settled=true;",
      `console.log('CLAWSEMBLY_EGRESS_DENIED:${label}:'`,
      "+(error?.code??error?.name??'unknown'));",
      "clearTimeout(watchdog);process.exit(0)};",
      `let socket;try{socket=${connection}}catch(error){denied(error)}`,
      "socket?.on('connect',()=>{console.error('unexpected connection');",
      "process.exit(2)});socket?.on('error',denied);",
      "const watchdog=setTimeout(()=>process.exit(124),15000);"
    ].join("");
    status.textContent = "Proving ungranted authority is denied…";
    const wrongPort = await runScript(denialScript(
      "wrong-port",
      "net.createConnection({host:'localhost',port:18793})"
    ));
    const unlistedHost = await runScript(denialScript(
      "unlisted-host",
      "net.createConnection({host:'example.com',port:443})"
    ));
    const rawIp = await runScript(denialScript(
      "raw-ip",
      "net.createConnection({host:'1.1.1.1',port:443})"
    ));
    const denials = { wrongPort, unlistedHost, rawIp };
    for (const [label, output] of Object.entries(denials)) {
      if (
        !output.ok
        || !output.stdout.includes(
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
