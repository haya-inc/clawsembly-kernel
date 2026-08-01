import assert from "node:assert/strict";
import test from "node:test";
import {
  startByokHttpBridge,
  type ByokBridgeDirectory
} from "../src/byok-http-bridge.ts";
import {
  byokLoopbackReadyMarker,
  createByokLoopbackBrokerHarness
} from "../src/byok-loopback-broker.ts";

class MemoryDirectory implements ByokBridgeDirectory {
  files = new Map<string, Uint8Array>();

  async readDir(path: string) {
    const prefix = `${path}/`;
    return [...this.files.keys()]
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => ({
        name: entry.slice(prefix.length),
        type: "file" as const
      }));
  }

  async readFile(path: string) {
    const value = this.files.get(path);
    if (!value) throw new Error("not found");
    return value;
  }

  async removeFile(path: string) {
    this.files.delete(path);
  }

  async writeFile(path: string, contents: string | Uint8Array) {
    this.files.set(
      path,
      typeof contents === "string"
        ? new TextEncoder().encode(contents)
        : contents
    );
  }
}

async function waitForFile(directory: MemoryDirectory, path: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = directory.files.get(path);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

test("forwards a model-bound mailbox request with only the opaque token", async () => {
  const directory = new MemoryDirectory();
  const calls: Array<{
    authorization: string | null;
    body: string;
    url: string;
  }> = [];
  const capability = {
    apiKey: "opaque-guest-capability",
    apiPath: "/v1/chat/completions" as const,
    baseUrl: "https://clawsembly.yhay81.com/api/byok/v1",
    expiresAt: "2026-07-29T01:00:00.000Z",
    modelApi: "openai-completions" as const,
    model: "gpt-5.6",
    openClawProvider: "clawsembly-byok" as const,
    providerId: "clawsembly-byok" as const
  };
  const bridge = startByokHttpBridge({
    capability,
    directory,
    pollIntervalMs: 1,
    fetchImpl: async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({
        authorization: headers.get("Authorization"),
        body: String(init?.body),
        url: String(input)
      });
      return new Response("data: {\"choices\":[]}\\n\\n", {
        headers: {
          "Content-Type": "text/event-stream"
        }
      });
    }
  });
  const body = JSON.stringify({
    model: "gpt-5.6",
    messages: [{ role: "user", content: "hello" }],
    stream: true
  });
  await directory.writeFile("/requests/request_1.json", JSON.stringify({
    schemaVersion: 1,
    id: "request_1",
    method: "POST",
    path: "/v1/chat/completions",
    authorization: "Bearer opaque-guest-capability",
    body
  }));

  const responseBytes = await waitForFile(
    directory,
    "/responses/request_1.json"
  );
  const response = JSON.parse(new TextDecoder().decode(responseBytes));
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "text/event-stream");
  assert.deepEqual(calls, [{
    authorization: "Bearer opaque-guest-capability",
    body,
    url:
      "https://clawsembly.yhay81.com/api/byok/v1/chat/completions"
  }]);
  assert.deepEqual(bridge.snapshot(), {
    failed: 0,
    forwarded: 1,
    providerCredentialRecorded: false,
    requestsSeen: 1
  });
  await bridge.stop();
});

test("rejects model or token widening before host fetch", async () => {
  const directory = new MemoryDirectory();
  let fetches = 0;
  const bridge = startByokHttpBridge({
    capability: {
      apiKey: "opaque-guest-capability",
      apiPath: "/v1/chat/completions",
      baseUrl: "https://clawsembly.yhay81.com/api/byok/v1",
      expiresAt: "2026-07-29T01:00:00.000Z",
      modelApi: "openai-completions",
      model: "gpt-5.6",
      openClawProvider: "clawsembly-byok",
      providerId: "clawsembly-byok"
    },
    directory,
    pollIntervalMs: 1,
    fetchImpl: async () => {
      fetches += 1;
      return new Response();
    }
  });
  await directory.writeFile("/requests/denied.json", JSON.stringify({
    schemaVersion: 1,
    id: "denied",
    method: "POST",
    path: "/v1/chat/completions",
    authorization: "Bearer wrong",
    body: JSON.stringify({
      model: "different-model",
      messages: [{ role: "user", content: "hello" }]
    })
  }));

  const responseBytes = await waitForFile(
    directory,
    "/responses/denied.json"
  );
  const response = JSON.parse(new TextDecoder().decode(responseBytes));
  assert.equal(response.status, 400);
  assert.equal(fetches, 0);
  await bridge.stop();
});

test("forwards an OAuth Responses capability only on its fixed path", async () => {
  const directory = new MemoryDirectory();
  const calls: string[] = [];
  const bridge = startByokHttpBridge({
    capability: {
      apiKey: "opaque-oauth-capability",
      apiPath: "/v1/responses",
      baseUrl: "https://clawsembly.yhay81.com/api/byok/v1",
      expiresAt: "2026-07-29T01:00:00.000Z",
      modelApi: "openai-chatgpt-responses",
      model: "gpt-5.6-sol",
      openClawProvider: "openai",
      providerId: "clawsembly-byok"
    },
    directory,
    pollIntervalMs: 1,
    fetchImpl: async (input) => {
      calls.push(String(input));
      return new Response("data: [DONE]\n\n", {
        headers: { "Content-Type": "text/event-stream" }
      });
    }
  });
  await directory.writeFile("/requests/oauth.json", JSON.stringify({
    schemaVersion: 1,
    id: "oauth",
    method: "POST",
    path: "/v1/responses",
    authorization: "Bearer opaque-oauth-capability",
    body: JSON.stringify({
      model: "gpt-5.6-sol",
      input: [{ role: "user", content: "hello" }],
      stream: true
    })
  }));
  const responseBytes = await waitForFile(
    directory,
    "/responses/oauth.json"
  );
  const response = JSON.parse(new TextDecoder().decode(responseBytes));
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    "https://clawsembly.yhay81.com/api/byok/v1/responses"
  ]);
  await bridge.stop();
});

test("builds a loopback-only guest broker harness", () => {
  const harness = createByokLoopbackBrokerHarness();
  assert.match(harness, /127\.0\.0\.1/u);
  assert.match(harness, /\/v1\/chat\/completions/u);
  assert.match(harness, new RegExp(byokLoopbackReadyMarker, "u"));
  assert.doesNotMatch(harness, /api\.openai\.com|apiKey|providerApiKey/u);
});
