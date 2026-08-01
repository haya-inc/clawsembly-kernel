import assert from "node:assert/strict";
import test from "node:test";
import worker from "../worker/index.mjs";
import {
  ByokCapabilityBroker
} from "../worker/byok-broker.mjs";

const sessionId = "a".repeat(64);
const providerApiKey = "sk-user-owned-provider-key";

class MemoryStorage {
  constructor() {
    this.values = new Map();
    this.alarm = undefined;
  }

  async get(key) {
    return this.values.get(key);
  }

  async put(key, value) {
    this.values.set(key, structuredClone(value));
  }

  async setAlarm(value) {
    this.alarm = value;
  }

  async deleteAll() {
    this.values.clear();
  }
}

function createBrokerEnvironment() {
  const storage = new MemoryStorage();
  const upstreamCalls = [];
  const broker = new ByokCapabilityBroker(
    { storage },
    {
      async BYOK_PROVIDER_FETCH(url, init) {
        upstreamCalls.push({
          url,
          authorization: init.headers.get("Authorization"),
          body: JSON.parse(new TextDecoder().decode(init.body))
        });
        return Response.json({
          id: "chatcmpl-test",
          choices: [{
            message: {
              role: "assistant",
              content: "READY"
            }
          }]
        }, {
          headers: {
            "X-Request-Id": "provider-request-1"
          }
        });
      }
    }
  );
  return { broker, storage, upstreamCalls };
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function openAiAccessToken(accountId, expiresAtSeconds) {
  return [
    base64UrlJson({ alg: "none", typ: "JWT" }),
    base64UrlJson({
      exp: expiresAtSeconds,
      "https://api.openai.com/auth": {
        chatgpt_account_id: accountId,
        chatgpt_plan_type: "plus"
      }
    }),
    "signature"
  ].join(".");
}

async function issue(broker) {
  const response = await broker.fetch(new Request(
    "https://byok.internal/issue",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        provider: "openai",
        model: "gpt-5.6",
        apiKey: providerApiKey
      })
    }
  ));
  assert.equal(response.status, 201);
  return response.json();
}

function completionRequest(token) {
  return new Request(
    "https://byok.internal/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-5.6",
        messages: [{
          role: "user",
          content: "Reply with exactly READY"
        }],
        stream: false
      })
    }
  );
}

test("keeps the provider key behind an opaque, revocable capability", async () => {
  const { broker, storage, upstreamCalls } = createBrokerEnvironment();
  const issued = await issue(broker);
  assert.equal(issued.status, "ready");
  assert.equal(JSON.stringify(issued).includes(providerApiKey), false);
  assert.equal(issued.capability.provider, "openai");
  assert.equal(issued.capability.model, "gpt-5.6");
  assert.equal(issued.capability.maxRequests, 64);
  assert.ok(storage.alarm > Date.now());

  const denied = await broker.fetch(completionRequest("wrong-capability"));
  assert.equal(denied.status, 401);
  assert.equal(upstreamCalls.length, 0);

  const completion = await broker.fetch(
    completionRequest(issued.capability.token)
  );
  assert.equal(completion.status, 200);
  assert.equal(
    completion.headers.get("X-Clawsembly-Credential-Boundary"),
    "opaque-capability"
  );
  assert.equal((await completion.json()).choices[0].message.content, "READY");
  assert.deepEqual(upstreamCalls, [{
    url: "https://api.openai.com/v1/chat/completions",
    authorization: `Bearer ${providerApiKey}`,
    body: {
      model: "gpt-5.6",
      messages: [{
        role: "user",
        content: "Reply with exactly READY"
      }],
      stream: false
    }
  }]);

  const revoked = await broker.fetch(new Request(
    "https://byok.internal/revoke",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${issued.capability.adminToken}`
      }
    }
  ));
  assert.equal(revoked.status, 200);
  assert.equal((await storage.get("session")).apiKey, null);

  const afterRevocation = await broker.fetch(
    completionRequest(issued.capability.token)
  );
  assert.equal(afterRevocation.status, 403);
  assert.equal(
    (await afterRevocation.json()).error.code,
    "capability_revoked"
  );
  assert.equal(upstreamCalls.length, 1);
});

test("rejects provider, model, and request widening", async () => {
  const { broker, upstreamCalls } = createBrokerEnvironment();
  const invalidProvider = await broker.fetch(new Request(
    "https://byok.internal/issue",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        provider: "custom",
        model: "model",
        apiKey: providerApiKey
      })
    }
  ));
  assert.equal(invalidProvider.status, 400);
  const inheritedProvider = await broker.fetch(new Request(
    "https://byok.internal/issue",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        provider: "__proto__",
        model: "model",
        apiKey: providerApiKey
      })
    }
  ));
  assert.equal(inheritedProvider.status, 400);

  const issued = await issue(broker);
  const widened = await broker.fetch(new Request(
    "https://byok.internal/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${issued.capability.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "different-model",
        messages: [{ role: "user", content: "hello" }]
      })
    }
  ));
  assert.equal(widened.status, 400);
  assert.equal((await widened.json()).error.code, "request_outside_capability");
  assert.equal(upstreamCalls.length, 0);
});

test("routes full public tokens without exposing provider credentials", async () => {
  const { broker, upstreamCalls } = createBrokerEnvironment();
  const durableObjectId = {
    toString() {
      return sessionId;
    }
  };
  const env = {
    BYOK_BROKERS: {
      newUniqueId() {
        return durableObjectId;
      },
      idFromString(value) {
        assert.equal(value, sessionId);
        return durableObjectId;
      },
      get() {
        return {
          fetch(request) {
            return broker.fetch(request);
          }
        };
      }
    }
  };
  const context = {
    waitUntil() {}
  };

  const crossOrigin = await worker.fetch(new Request(
    "https://clawsembly.yhay81.com/api/byok/capabilities",
    {
      method: "POST",
      headers: {
        Origin: "https://attacker.example",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        provider: "openai",
        model: "gpt-5.6",
        apiKey: providerApiKey
      })
    }
  ), env, context);
  assert.equal(crossOrigin.status, 403);

  const issuedResponse = await worker.fetch(new Request(
    "https://clawsembly.yhay81.com/api/byok/capabilities",
    {
      method: "POST",
      headers: {
        Origin: "https://clawsembly.yhay81.com",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        provider: "openai",
        model: "gpt-5.6",
        apiKey: providerApiKey
      })
    }
  ), env, context);
  assert.equal(issuedResponse.status, 201);
  const issued = await issuedResponse.json();
  assert.equal(
    issued.capability.baseUrl,
    "https://clawsembly.yhay81.com/api/byok/v1"
  );
  assert.ok(issued.capability.token.startsWith(`${sessionId}.`));
  assert.ok(issued.capability.adminToken.startsWith(`${sessionId}.`));
  assert.equal(JSON.stringify(issued).includes(providerApiKey), false);

  const completion = await worker.fetch(new Request(
    "https://clawsembly.yhay81.com/api/byok/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${issued.capability.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-5.6",
        messages: [{
          role: "user",
          content: "Reply with exactly READY"
        }],
        stream: false
      })
    }
  ), env, context);
  assert.equal(completion.status, 200);
  assert.equal((await completion.json()).choices[0].message.content, "READY");
  assert.equal(upstreamCalls[0].authorization, `Bearer ${providerApiKey}`);

  const revoked = await worker.fetch(new Request(
    "https://clawsembly.yhay81.com/api/byok/capabilities/revoke",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${issued.capability.adminToken}`
      }
    }
  ), env, context);
  assert.equal(revoked.status, 200);
});

test("deletes expired session authority when the alarm fires", async () => {
  const { broker, storage } = createBrokerEnvironment();
  await issue(broker);
  assert.ok(await storage.get("session"));
  await broker.alarm();
  assert.equal(await storage.get("session"), undefined);
});

test("keeps OpenAI device OAuth and refresh tokens behind the same capability", async () => {
  const storage = new MemoryStorage();
  const oauthCalls = [];
  const upstreamCalls = [];
  const accountId = "chatgpt-account-clawsembly";
  const firstAccess = openAiAccessToken(
    accountId,
    Math.floor(Date.now() / 1_000) + 3_600
  );
  const refreshedAccess = openAiAccessToken(
    accountId,
    Math.floor(Date.now() / 1_000) + 7_200
  );
  let exchangeComplete = false;
  const broker = new ByokCapabilityBroker(
    { storage },
    {
      async OPENAI_OAUTH_FETCH(url, init) {
        const body = String(init.body);
        oauthCalls.push({ url, body });
        if (url.endsWith("/api/accounts/deviceauth/usercode")) {
          return Response.json({
            device_auth_id: "device-auth-id",
            user_code: "ABCD-EFGH",
            interval: 1
          });
        }
        if (url.endsWith("/api/accounts/deviceauth/token")) {
          return Response.json({
            authorization_code: "authorization-code",
            code_verifier: "code-verifier"
          });
        }
        if (
          url.endsWith("/oauth/token")
          && body.includes("grant_type=authorization_code")
        ) {
          exchangeComplete = true;
          return Response.json({
            access_token: firstAccess,
            refresh_token: "refresh-token-1",
            expires_in: 1
          });
        }
        if (
          url.endsWith("/oauth/token")
          && body.includes("grant_type=refresh_token")
        ) {
          return Response.json({
            access_token: refreshedAccess,
            refresh_token: "refresh-token-2",
            expires_in: 3_600
          });
        }
        throw new Error(`Unexpected OAuth URL: ${url}`);
      },
      async BYOK_PROVIDER_FETCH(url, init) {
        upstreamCalls.push({
          url,
          authorization: init.headers.get("Authorization"),
          accountId: init.headers.get("ChatGPT-Account-Id"),
          originator: init.headers.get("originator"),
          body: JSON.parse(new TextDecoder().decode(init.body))
        });
        return new Response([
          "data: {\"type\":\"response.completed\",\"response\":",
          "{\"id\":\"resp_test\",\"output\":[],\"usage\":",
          "{\"input_tokens\":1,\"output_tokens\":1}}}\n\n",
          "data: [DONE]\n\n"
        ].join(""), {
          headers: {
            "Content-Type": "text/event-stream"
          }
        });
      }
    }
  );

  const startedResponse = await broker.fetch(new Request(
    "https://byok.internal/oauth/openai/device/start",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol" })
    }
  ));
  assert.equal(startedResponse.status, 201);
  const started = await startedResponse.json();
  assert.equal(started.status, "authorization_pending");
  assert.equal(started.authorization.userCode, "ABCD-EFGH");
  assert.equal(JSON.stringify(started).includes("device-auth-id"), false);

  const polledResponse = await broker.fetch(new Request(
    "https://byok.internal/oauth/openai/device/poll",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${started.pollToken}`
      }
    }
  ));
  assert.equal(polledResponse.status, 200);
  const polled = await polledResponse.json();
  assert.equal(polled.status, "ready");
  assert.equal(polled.capability.apiPath, "/v1/responses");
  assert.equal(polled.capability.modelApi, "openai-chatgpt-responses");
  assert.equal(polled.capability.openClawProvider, "openai");
  assert.equal(JSON.stringify(polled).includes(firstAccess), false);
  assert.equal(exchangeComplete, true);

  const response = await broker.fetch(new Request(
    "https://byok.internal/v1/responses",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${polled.capability.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        input: [{
          role: "user",
          content: [{ type: "input_text", text: "hello" }]
        }],
        stream: true,
        max_output_tokens: 512,
        store: false
      })
    }
  ));
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("X-Clawsembly-Credential-Boundary"),
    "opaque-capability"
  );
  assert.equal(upstreamCalls.length, 1);
  assert.deepEqual(upstreamCalls[0], {
    url: "https://chatgpt.com/backend-api/codex/responses",
    authorization: `Bearer ${refreshedAccess}`,
    accountId,
    originator: "openclaw",
    body: {
      model: "gpt-5.6-sol",
      input: [{
        role: "user",
        content: [{ type: "input_text", text: "hello" }]
      }],
      stream: true,
      instructions: "You are a helpful assistant."
    }
  });
  const stored = await storage.get("session");
  assert.equal(stored.accessToken, refreshedAccess);
  assert.equal(stored.refreshToken, "refresh-token-2");

  const revoked = await broker.fetch(new Request(
    "https://byok.internal/revoke",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${started.adminToken}`
      }
    }
  ));
  assert.equal(revoked.status, 200);
  const revokedSession = await storage.get("session");
  assert.equal(revokedSession.accessToken, null);
  assert.equal(revokedSession.refreshToken, null);
});

test("routes OpenAI device authorization and Responses without exposing OAuth tokens", async () => {
  const storage = new MemoryStorage();
  const accountId = "chatgpt-account-public-route";
  const accessToken = openAiAccessToken(
    accountId,
    Math.floor(Date.now() / 1_000) + 3_600
  );
  let providerAuthorization;
  const broker = new ByokCapabilityBroker(
    { storage },
    {
      async OPENAI_OAUTH_FETCH(url) {
        if (url.endsWith("/api/accounts/deviceauth/usercode")) {
          return Response.json({
            device_auth_id: "public-device-id",
            user_code: "ROUTE-CODE",
            interval: 1
          });
        }
        if (url.endsWith("/api/accounts/deviceauth/token")) {
          return Response.json({
            authorization_code: "public-auth-code",
            code_verifier: "public-verifier"
          });
        }
        return Response.json({
          access_token: accessToken,
          refresh_token: "public-refresh-token",
          expires_in: 3_600
        });
      },
      async BYOK_PROVIDER_FETCH(_url, init) {
        providerAuthorization = init.headers.get("Authorization");
        return Response.json({ id: "resp_public", output: [] });
      }
    }
  );
  const durableObjectId = {
    toString() {
      return sessionId;
    }
  };
  const env = {
    BYOK_BROKERS: {
      newUniqueId() {
        return durableObjectId;
      },
      idFromString(value) {
        assert.equal(value, sessionId);
        return durableObjectId;
      },
      get() {
        return {
          fetch(request) {
            return broker.fetch(request);
          }
        };
      }
    }
  };
  const context = { waitUntil() {} };

  const startResponse = await worker.fetch(new Request(
    "https://clawsembly.yhay81.com/api/oauth/openai/device/start",
    {
      method: "POST",
      headers: {
        Origin: "https://clawsembly.yhay81.com",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ model: "gpt-5.6-sol" })
    }
  ), env, context);
  assert.equal(startResponse.status, 201);
  const started = await startResponse.json();
  assert.ok(started.pollToken.startsWith(`${sessionId}.`));
  assert.ok(started.adminToken.startsWith(`${sessionId}.`));
  assert.equal(JSON.stringify(started).includes("public-device-id"), false);

  const pollResponse = await worker.fetch(new Request(
    started.pollUrl,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${started.pollToken}`
      }
    }
  ), env, context);
  assert.equal(pollResponse.status, 200);
  const polled = await pollResponse.json();
  assert.ok(polled.capability.token.startsWith(`${sessionId}.`));
  assert.equal(
    polled.capability.baseUrl,
    "https://clawsembly.yhay81.com/api/byok/v1"
  );
  assert.equal(JSON.stringify(polled).includes(accessToken), false);
  assert.equal(JSON.stringify(polled).includes("public-refresh-token"), false);

  const modelResponse = await worker.fetch(new Request(
    `${polled.capability.baseUrl}/responses`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${polled.capability.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        input: [{ role: "user", content: "hello" }],
        stream: false
      })
    }
  ), env, context);
  assert.equal(modelResponse.status, 200);
  assert.equal(providerAuthorization, `Bearer ${accessToken}`);
});
