import { expect, test } from "@playwright/test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:net";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

type BrowserEvidence = {
  schemaVersion: number;
  status: string;
  network: {
    namespace: string;
    loopback: {
      client: { ok: boolean; stdout: string };
      server: { ok: boolean; stdout: string };
    };
    egress: {
      authorized: { ok: boolean; stdout: string };
      credentialTransport: string;
      denied: Record<string, { ok: boolean; stdout: string }>;
      tokenRecorded: boolean;
      transport: string;
    };
  };
};

const artifactPath = process.env.CLAWSEMBLY_EDGE_WASIX;
const relayPath = process.env.CLAWSEMBLY_NETWORK_RELAY;
const relayToken = "clawsembly-browser-egress-proof";

// The Wasmer SDK has no public API for terminating a WASIX Instance blocked
// inside a syscall. A test timeout tears down the Playwright worker and all of
// its browser Web Workers; a retry therefore starts the entire proof cold.
// Failed attempts never write evidence, while a successful attempt must still
// satisfy every assertion below.
test.describe.configure({ mode: "serial", retries: 2 });

test("reports the Edge.js globals required by Undici", async ({ page }) => {
  test.skip(
    artifactPath === undefined || !existsSync(artifactPath),
    "Set CLAWSEMBLY_EDGE_WASIX"
  );
  test.setTimeout(75_000);
  await page.route((url) => url.pathname === "/edgejs.wasm", async (route) => {
    await route.fulfill({
      contentType: "application/wasm",
      path: path.resolve(artifactPath!)
    });
  });
  await page.goto(
    "/network-egress-probe.html?artifact=/edgejs.wasm"
    + "&mode=http-globals"
    + `&token=${encodeURIComponent(relayToken)}`
  );
  const status = page.locator("#status");
  await expect.poll(
    () => status.getAttribute("data-state"),
    { timeout: 60_000 }
  ).toMatch(/^(?:pass|fail)$/u);
  if (await status.getAttribute("data-state") === "fail") {
    throw new Error(await page.locator("#result").innerText());
  }
  const evidence = JSON.parse(await page.locator("#result").innerText()) as {
    output: {
      ok: boolean;
      stdout: string;
    };
    status: string;
  };
  expect(evidence.status).toBe("http-globals-inspected");
  expect(evidence.output.ok).toBe(true);
  expect(evidence.output.stdout).toContain("CLAWSEMBLY_HTTP_GLOBALS=");
  console.info(evidence.output.stdout);
});

test("captures the Edge.js HTTP fetch diagnostic", async ({ page }) => {
  test.skip(
    artifactPath === undefined
      || relayPath === undefined
      || !existsSync(artifactPath)
      || !existsSync(relayPath),
    "Set CLAWSEMBLY_EDGE_WASIX and CLAWSEMBLY_NETWORK_RELAY"
  );
  test.setTimeout(75_000);
  const fixture = await startFixture();
  let relay: ChildProcessWithoutNullStreams | undefined;
  try {
    relay = await startRelay(path.resolve(relayPath!));
    await page.route((url) => url.pathname === "/edgejs.wasm", async (route) => {
      await route.fulfill({
        contentType: "application/wasm",
        path: path.resolve(artifactPath!)
      });
    });
    await page.goto(
      "/network-egress-probe.html?artifact=/edgejs.wasm"
      + "&mode=http-fetch-diagnostic"
      + `&token=${encodeURIComponent(relayToken)}`
    );
    const status = page.locator("#status");
    await expect.poll(
      () => status.getAttribute("data-state"),
      { timeout: 60_000 }
    ).toMatch(/^(?:pass|fail)$/u);
    if (await status.getAttribute("data-state") === "fail") {
      throw new Error(await page.locator("#result").innerText());
    }
    const evidence = JSON.parse(await page.locator("#result").innerText()) as {
      status: string;
      stderr: string;
      stdout: string;
    };
    expect(evidence.status).toBe("http-fetch-pass");
    const combined = `${evidence.stdout}\n${evidence.stderr}`;
    const marker = combined
      .split(/\r?\n/u)
      .find((line) => line.startsWith(
        "CLAWSEMBLY_HTTP_FETCH_DIAGNOSTIC="
      ));
    expect(marker).toBeDefined();
    expect(JSON.parse(
      marker!.slice("CLAWSEMBLY_HTTP_FETCH_DIAGNOSTIC=".length)
    )).toEqual({
      ok: true,
      value: {
        body: "egress-http-pong",
        ok: true,
        status: 200
      }
    });
    console.info(combined);
  } finally {
    relay?.kill("SIGTERM");
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  }
});

test("grants exact TCP egress without replacing browser-local loopback", async ({
  page
}, testInfo) => {
  test.skip(
    artifactPath === undefined
      || relayPath === undefined
      || !existsSync(artifactPath)
      || !existsSync(relayPath),
    "Set CLAWSEMBLY_EDGE_WASIX and CLAWSEMBLY_NETWORK_RELAY"
  );
  test.setTimeout(120_000);

  const fixture = await startFixture();
  let relay: ChildProcessWithoutNullStreams | undefined;
  try {
    relay = await startRelay(path.resolve(relayPath!));
    const resolvedArtifact = path.resolve(artifactPath!);
    await page.route((url) => url.pathname === "/edgejs.wasm", async (route) => {
      await route.fulfill({
        contentType: "application/wasm",
        path: resolvedArtifact
      });
    });
    page.on("console", (message) => {
      if (
        /network|resolve|getaddrinfo|permission|denied|connect_tcp/iu.test(
          message.text()
        )
      ) {
        console.log(`[browser:${message.type()}] ${message.text()}`);
      }
    });
    const pageError = page.waitForEvent("pageerror");
    await page.goto(
      "/network-egress-probe.html?artifact=/edgejs.wasm"
      + "&relay=ws%3A%2F%2F127.0.0.1%3A18792%2Fv1%2Fnetwork"
      + "&debug=1"
      + `&token=${encodeURIComponent(relayToken)}`
    );
    const status = page.locator("#status");
    const outcome = await Promise.race([
      expect.poll(
        () => status.getAttribute("data-state"),
        { timeout: 105_000 }
      ).toMatch(/^(?:pass|fail)$/u).then(() => ({ kind: "status" as const })),
      pageError.then((error) => ({ error, kind: "pageerror" as const }))
    ]);
    if (outcome.kind === "pageerror") throw outcome.error;
    if (await status.getAttribute("data-state") === "fail") {
      throw new Error(await page.locator("#result").innerText());
    }

    const evidence = JSON.parse(
      await page.locator("#result").innerText()
    ) as BrowserEvidence;
    expect(evidence).toMatchObject({
      schemaVersion: 1,
      status: "capability-egress-pass",
      network: {
        namespace: "browser-local-loopback+capability-egress",
        loopback: {
          server: { ok: true },
          client: { ok: true }
        },
        egress: {
          transport: "self-hosted-virtual-net-websocket-relay",
          credentialTransport: "Sec-WebSocket-Protocol",
          tokenRecorded: false,
          authorized: { ok: true },
          denied: {
            wrongPort: { ok: true },
            unlistedHost: { ok: true },
            rawIp: { ok: true }
          }
        }
      }
    });
    expect(evidence.network.loopback.server.stdout).toContain(
      "CLAWSEMBLY_EGRESS_LOOPBACK_SERVER=ping:pong"
    );
    expect(evidence.network.loopback.client.stdout).toContain(
      "CLAWSEMBLY_EGRESS_LOOPBACK_CLIENT=pong"
    );
    expect(evidence.network.egress.authorized.stdout).toContain(
      "CLAWSEMBLY_EGRESS_AUTHORIZED=egress-pong"
    );
    expect(evidence.network.egress.denied.wrongPort.stdout).toContain(
      "CLAWSEMBLY_EGRESS_DENIED:wrong-port:"
    );
    expect(evidence.network.egress.denied.unlistedHost.stdout).toContain(
      "CLAWSEMBLY_EGRESS_DENIED:unlisted-host:"
    );
    expect(evidence.network.egress.denied.rawIp.stdout).toContain(
      "CLAWSEMBLY_EGRESS_DENIED:raw-ip:"
    );
    writeFileSync(
      testInfo.outputPath("network-egress-browser-evidence.json"),
      `${JSON.stringify(evidence, null, 2)}\n`
    );
  } finally {
    relay?.kill("SIGTERM");
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  }
});

async function startFixture(): Promise<Server> {
  const fixture = createServer((socket) => {
    socket.setEncoding("utf8");
    let request = "";
    socket.on("data", (chunk: string) => {
      request += chunk;
      if (request.startsWith("GET /fixture-http ")) {
        socket.end([
          "HTTP/1.1 200 OK",
          "Connection: close",
          "Content-Length: 16",
          "Content-Type: text/plain",
          "",
          "egress-http-pong"
        ].join("\r\n"));
        return;
      }
      if (request === "egress-ping") {
        socket.end("egress-pong");
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    fixture.once("error", reject);
    fixture.listen({ host: "::", port: 18_791, ipv6Only: false }, () => {
      fixture.off("error", reject);
      resolve();
    });
  });
  return fixture;
}

async function startRelay(
  executable: string
): Promise<ChildProcessWithoutNullStreams> {
  const relay = spawn(executable, [
    "--listen",
    "127.0.0.1:18792",
    "--allow",
    "localhost:18791",
    "--allow-private-network"
  ], {
    env: {
      ...process.env,
      CLAWSEMBLY_NETWORK_RELAY_TOKEN: relayToken
    },
    stdio: "pipe"
  });
  let stdout = "";
  let stderr = "";
  relay.stdout.setEncoding("utf8");
  relay.stderr.setEncoding("utf8");
  relay.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    console.log(`[relay:stdout] ${chunk.trimEnd()}`);
  });
  relay.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    console.log(`[relay:stderr] ${chunk.trimEnd()}`);
  });
  await Promise.race([
    new Promise<void>((resolve, reject) => {
      const interval = setInterval(() => {
        if (stdout.includes("\"status\":\"ready\"")) {
          clearInterval(interval);
          resolve();
        }
      }, 10);
      relay.once("exit", (code) => {
        clearInterval(interval);
        reject(
          new Error(
            `network relay exited before readiness (${code}): ${stderr || stdout}`
          )
        );
      });
    }),
    new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`network relay readiness timeout: ${stderr}`)),
        10_000
      );
    })
  ]);
  return relay;
}
