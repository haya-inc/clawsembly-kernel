const SESSION_KEY = "session";
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TTL_SECONDS = 30 * 60;
const DEFAULT_MAX_REQUESTS = 64;

export const BYOK_PROVIDERS = Object.freeze({
  openai: Object.freeze({
    label: "OpenAI",
    upstream: "https://api.openai.com/v1/chat/completions"
  }),
  openrouter: Object.freeze({
    label: "OpenRouter",
    upstream: "https://openrouter.ai/api/v1/chat/completions"
  })
});

function jsonResponse(value, status = 200) {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store"
    }
  });
}

function errorResponse(code, status) {
  return jsonResponse({
    schemaVersion: 1,
    status: "error",
    error: { code }
  }, status);
}

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function randomSecret() {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function secretDigest(secret) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret)
  );
  return base64Url(new Uint8Array(digest));
}

function fixedLengthEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function bearerToken(request) {
  const value = request.headers.get("Authorization");
  return value?.startsWith("Bearer ") ? value.slice("Bearer ".length) : "";
}

function validApiKey(value) {
  return typeof value === "string"
    && value.length >= 8
    && value.length <= 2_048
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validModel(value) {
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u.test(value);
}

async function readBoundedJson(request) {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new TypeError("content_type");
  }
  const declaredLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new RangeError("body_too_large");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_REQUEST_BYTES) {
    throw new RangeError("body_too_large");
  }
  try {
    return {
      bytes,
      value: JSON.parse(new TextDecoder().decode(bytes))
    };
  } catch {
    throw new SyntaxError("invalid_json");
  }
}

function validateCompletion(value, model) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && value.model === model
    && Array.isArray(value.messages)
    && value.messages.length > 0;
}

function selectedResponseHeaders(upstream) {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "X-Clawsembly-Credential-Boundary": "opaque-capability"
  });
  for (const name of [
    "Content-Type",
    "OpenAI-Organization",
    "OpenAI-Processing-Ms",
    "X-Request-Id"
  ]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function boundedResponseBody(body) {
  if (!body) return null;
  let bytes = 0;
  return body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        controller.error(new Error("provider_response_too_large"));
        return;
      }
      controller.enqueue(chunk);
    }
  }));
}

export class ByokCapabilityBroker {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/issue") return this.issue(request);
    if (pathname === "/v1/chat/completions") {
      return this.complete(request);
    }
    if (pathname === "/revoke") return this.revoke(request);
    return errorResponse("not_found", 404);
  }

  async issue(request) {
    if (request.method !== "POST") {
      return errorResponse("method_not_allowed", 405);
    }
    let input;
    try {
      input = (await readBoundedJson(request)).value;
    } catch (error) {
      return errorResponse(
        error instanceof RangeError ? "body_too_large" : "invalid_request",
        error instanceof RangeError ? 413 : 400
      );
    }
    const provider = typeof input?.provider === "string"
      && Object.hasOwn(BYOK_PROVIDERS, input.provider)
      ? BYOK_PROVIDERS[input.provider]
      : undefined;
    if (
      !provider
      || !validApiKey(input.apiKey)
      || !validModel(input.model)
    ) {
      return errorResponse("invalid_capability_request", 400);
    }

    const existing = await this.state.storage.get(SESSION_KEY);
    if (existing) return errorResponse("capability_already_issued", 409);

    const guestSecret = randomSecret();
    const adminSecret = randomSecret();
    const now = Date.now();
    const expiresAt = now + DEFAULT_TTL_SECONDS * 1_000;
    await this.state.storage.put(SESSION_KEY, {
      apiKey: input.apiKey,
      provider: input.provider,
      model: input.model,
      guestDigest: await secretDigest(guestSecret),
      adminDigest: await secretDigest(adminSecret),
      createdAt: now,
      expiresAt,
      maxRequests: DEFAULT_MAX_REQUESTS,
      requestCount: 0,
      revoked: false
    });
    await this.state.storage.setAlarm?.(expiresAt);

    return jsonResponse({
      schemaVersion: 1,
      status: "ready",
      capability: {
        token: guestSecret,
        adminToken: adminSecret,
        provider: input.provider,
        providerLabel: provider.label,
        model: input.model,
        expiresAt: new Date(expiresAt).toISOString(),
        maxRequests: DEFAULT_MAX_REQUESTS
      }
    }, 201);
  }

  async complete(request) {
    if (request.method !== "POST") {
      return errorResponse("method_not_allowed", 405);
    }
    const session = await this.state.storage.get(SESSION_KEY);
    if (!session) return errorResponse("capability_not_found", 404);
    if (session.revoked || !session.apiKey) {
      return errorResponse("capability_revoked", 403);
    }
    if (Date.now() >= session.expiresAt) {
      return errorResponse("capability_expired", 403);
    }
    const candidateDigest = await secretDigest(bearerToken(request));
    if (!fixedLengthEqual(candidateDigest, session.guestDigest)) {
      return errorResponse("unauthorized", 401);
    }
    if (session.requestCount >= session.maxRequests) {
      return errorResponse("request_budget_exhausted", 429);
    }

    let parsed;
    try {
      parsed = await readBoundedJson(request);
    } catch (error) {
      return errorResponse(
        error instanceof RangeError ? "body_too_large" : "invalid_request",
        error instanceof RangeError ? 413 : 400
      );
    }
    if (!validateCompletion(parsed.value, session.model)) {
      return errorResponse("request_outside_capability", 400);
    }

    const reserveRequest = async () => {
      const current = await this.state.storage.get(SESSION_KEY);
      if (!current) return errorResponse("capability_not_found", 404);
      if (current.revoked || !current.apiKey) {
        return errorResponse("capability_revoked", 403);
      }
      if (Date.now() >= current.expiresAt) {
        return errorResponse("capability_expired", 403);
      }
      const currentCandidateDigest =
        await secretDigest(bearerToken(request));
      if (
        !fixedLengthEqual(currentCandidateDigest, current.guestDigest)
      ) {
        return errorResponse("unauthorized", 401);
      }
      if (current.requestCount >= current.maxRequests) {
        return errorResponse("request_budget_exhausted", 429);
      }
      current.requestCount += 1;
      await this.state.storage.put(SESSION_KEY, current);
      return current;
    };
    const reserved = this.state.blockConcurrencyWhile
      ? await this.state.blockConcurrencyWhile(reserveRequest)
      : await reserveRequest();
    if (reserved instanceof Response) return reserved;
    const provider = BYOK_PROVIDERS[reserved.provider];
    const headers = new Headers({
      Accept: parsed.value.stream === true
        ? "text/event-stream"
        : "application/json",
      Authorization: `Bearer ${reserved.apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "Clawsembly-BYOK/0.1"
    });
    if (reserved.provider === "openrouter") {
      headers.set("HTTP-Referer", "https://clawsembly.yhay81.com/");
      headers.set("X-Title", "Clawsembly");
    }

    let upstream;
    try {
      const providerFetch = this.env.BYOK_PROVIDER_FETCH ?? fetch;
      upstream = await providerFetch(provider.upstream, {
        method: "POST",
        headers,
        body: parsed.bytes
      });
    } catch {
      return errorResponse("provider_unreachable", 502);
    }
    return new Response(boundedResponseBody(upstream.body), {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: selectedResponseHeaders(upstream)
    });
  }

  async revoke(request) {
    if (request.method !== "POST") {
      return errorResponse("method_not_allowed", 405);
    }
    const session = await this.state.storage.get(SESSION_KEY);
    if (!session) return errorResponse("capability_not_found", 404);
    const candidateDigest = await secretDigest(bearerToken(request));
    if (!fixedLengthEqual(candidateDigest, session.adminDigest)) {
      return errorResponse("unauthorized", 401);
    }
    const alreadyRevoked = session.revoked;
    session.revoked = true;
    session.apiKey = null;
    await this.state.storage.put(SESSION_KEY, session);
    return jsonResponse({
      schemaVersion: 1,
      status: "revoked",
      alreadyRevoked
    });
  }

  async alarm() {
    await this.state.storage.deleteAll();
  }
}
