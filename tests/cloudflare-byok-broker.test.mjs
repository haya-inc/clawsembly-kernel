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
