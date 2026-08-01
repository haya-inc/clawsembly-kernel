const SESSION_KEY = "session";
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TTL_SECONDS = 30 * 60;
const DEFAULT_MAX_REQUESTS = 64;
const OPENAI_AUTH_BASE_URL = "https://auth.openai.com";
const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_CODEX_CALLBACK_URL =
  `${OPENAI_AUTH_BASE_URL}/deviceauth/callback`;
const OPENAI_CODEX_RESPONSES_URL =
  "https://chatgpt.com/backend-api/codex/responses";
const OPENAI_DEVICE_VERIFY_URL =
  `${OPENAI_AUTH_BASE_URL}/codex/device`;
const OPENAI_DEVICE_TTL_MS = 15 * 60 * 1_000;
const OPENAI_DEFAULT_POLL_INTERVAL_MS = 5_000;
const OPENAI_MIN_POLL_INTERVAL_MS = 1_000;
const OPENAI_REFRESH_SKEW_MS = 60_000;
const OPENCLAW_VERSION = "2026.7.1-2";

export const BYOK_PROVIDERS = Object.freeze({
  openai: Object.freeze({
    apiPath: "/v1/chat/completions",
    label: "OpenAI",
    modelApi: "openai-completions",
    openClawProvider: "clawsembly-byok",
    upstream: "https://api.openai.com/v1/chat/completions"
  }),
  openrouter: Object.freeze({
    apiPath: "/v1/chat/completions",
    label: "OpenRouter",
    modelApi: "openai-completions",
    openClawProvider: "clawsembly-byok",
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

function positiveMillisecondsFromSeconds(value) {
  const seconds = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.max(1_000, Math.trunc(seconds * 1_000));
}

function decodeJwtPayload(token) {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3) return undefined;
  try {
    const normalized = parts[1]
      .replaceAll("-", "+")
      .replaceAll("_", "/")
      .padEnd(Math.ceil(parts[1].length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(normalized), (character) =>
      character.charCodeAt(0));
    const value = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function resolveOpenAiIdentity(accessToken) {
  const payload = decodeJwtPayload(accessToken);
  const auth = payload?.["https://api.openai.com/auth"];
  const accountId = typeof auth?.chatgpt_account_id === "string"
    ? auth.chatgpt_account_id.trim()
    : "";
  const expiresAt = Number.isFinite(Number(payload?.exp))
    ? Math.trunc(Number(payload.exp) * 1_000)
    : undefined;
  return {
    accountId: accountId || undefined,
    expiresAt
  };
}

function openAiHeaders(contentType) {
  return {
    "Content-Type": contentType,
    originator: "openclaw",
    version: OPENCLAW_VERSION,
    "User-Agent": `openclaw/${OPENCLAW_VERSION}`
  };
}

async function readJsonResponse(response) {
  const text = await response.text();
  let value;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    value = {};
  }
  return { text, value };
}

function openAiError(code, status) {
  return jsonResponse({
    schemaVersion: 1,
    status: "error",
    error: {
      code
    }
  }, status);
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

function validateResponses(value, model) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && value.model === model
    && Array.isArray(value.input)
    && value.input.length > 0;
}

function sanitizeCodexResponses(value) {
  const sanitized = { ...value };
  for (const key of [
    "max_output_tokens",
    "metadata",
    "prompt_cache_retention",
    "service_tier",
    "store",
    "temperature",
    "top_p"
  ]) {
    delete sanitized[key];
  }
  if (
    !sanitized.instructions
    || typeof sanitized.instructions !== "string"
    || sanitized.instructions.trim().length === 0
  ) {
    sanitized.instructions = "You are a helpful assistant.";
  }
  if (
    sanitized.text
    && typeof sanitized.text === "object"
    && !Array.isArray(sanitized.text)
  ) {
    const text = { ...sanitized.text };
    delete text.format;
    if (Object.keys(text).length > 0) sanitized.text = text;
    else delete sanitized.text;
  }
  return sanitized;
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
    if (pathname === "/oauth/openai/device/start") {
      return this.startOpenAiDeviceCode(request);
    }
    if (pathname === "/oauth/openai/device/poll") {
      return this.state.blockConcurrencyWhile
        ? this.state.blockConcurrencyWhile(
            () => this.pollOpenAiDeviceCode(request)
          )
        : this.pollOpenAiDeviceCode(request);
    }
    if (pathname === "/v1/chat/completions") {
      return this.forwardModelRequest(request, "chat-completions");
    }
    if (pathname === "/v1/responses") {
      return this.forwardModelRequest(request, "responses");
    }
    if (pathname === "/revoke") return this.revoke(request);
    return errorResponse("not_found", 404);
  }

  oauthFetch() {
    return this.env.OPENAI_OAUTH_FETCH ?? fetch;
  }

  async startOpenAiDeviceCode(request) {
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
    if (!validModel(input?.model)) {
      return errorResponse("invalid_capability_request", 400);
    }
    if (await this.state.storage.get(SESSION_KEY)) {
      return errorResponse("capability_already_issued", 409);
    }

    let response;
    try {
      response = await this.oauthFetch()(
        `${OPENAI_AUTH_BASE_URL}/api/accounts/deviceauth/usercode`,
        {
          method: "POST",
          headers: openAiHeaders("application/json"),
          body: JSON.stringify({ client_id: OPENAI_CODEX_CLIENT_ID })
        }
      );
    } catch {
      return openAiError("openai_device_unreachable", 502);
    }
    const { value } = await readJsonResponse(response);
    if (!response.ok) {
      return openAiError(
        "openai_device_start_failed",
        response.status === 429 ? 429 : 502
      );
    }
    const deviceAuthId = typeof value.device_auth_id === "string"
      ? value.device_auth_id.trim()
      : "";
    const userCodeCandidate = value.user_code ?? value.usercode;
    const userCode = typeof userCodeCandidate === "string"
      ? userCodeCandidate.trim()
      : "";
    if (!deviceAuthId || !userCode) {
      return openAiError("openai_device_response_invalid", 502);
    }

    const pollSecret = randomSecret();
    const adminSecret = randomSecret();
    const now = Date.now();
    const expiresAt = now + OPENAI_DEVICE_TTL_MS;
    const intervalMs = Math.max(
      OPENAI_MIN_POLL_INTERVAL_MS,
      positiveMillisecondsFromSeconds(value.interval)
        ?? OPENAI_DEFAULT_POLL_INTERVAL_MS
    );
    await this.state.storage.put(SESSION_KEY, {
      authType: "openai-oauth",
      state: "pending",
      provider: "openai",
      providerLabel: "OpenAI ChatGPT",
      model: input.model,
      apiPath: "/v1/responses",
      modelApi: "openai-chatgpt-responses",
      openClawProvider: "openai",
      deviceAuthId,
      userCode,
      intervalMs,
      nextPollAt: now,
      pollDigest: await secretDigest(pollSecret),
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
      status: "authorization_pending",
      authorization: {
        verificationUrl: OPENAI_DEVICE_VERIFY_URL,
        userCode,
        intervalMs,
        expiresAt: new Date(expiresAt).toISOString()
      },
      pollToken: pollSecret,
      adminToken: adminSecret
    }, 201);
  }

  async exchangeOpenAiDeviceAuthorization(authorizationCode, codeVerifier) {
    let response;
    try {
      response = await this.oauthFetch()(
        `${OPENAI_AUTH_BASE_URL}/oauth/token`,
        {
          method: "POST",
          headers: openAiHeaders("application/x-www-form-urlencoded"),
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: authorizationCode,
            redirect_uri: OPENAI_CODEX_CALLBACK_URL,
            client_id: OPENAI_CODEX_CLIENT_ID,
            code_verifier: codeVerifier
          })
        }
      );
    } catch {
      return { error: openAiError("openai_token_unreachable", 502) };
    }
    const { value } = await readJsonResponse(response);
    const accessToken = typeof value.access_token === "string"
      ? value.access_token.trim()
      : "";
    const refreshToken = typeof value.refresh_token === "string"
      ? value.refresh_token.trim()
      : "";
    if (!response.ok || !accessToken || !refreshToken) {
      return {
        error: openAiError(
          "openai_token_exchange_failed",
          502
        )
      };
    }
    const identity = resolveOpenAiIdentity(accessToken);
    if (!identity.accountId) {
      return {
        error: openAiError("openai_account_identity_missing", 502)
      };
    }
    return {
      credentials: {
        accessToken,
        refreshToken,
        accountId: identity.accountId,
        tokenExpiresAt:
          Date.now()
          + (
            positiveMillisecondsFromSeconds(value.expires_in)
            ?? Math.max(1_000, (identity.expiresAt ?? Date.now()) - Date.now())
          )
      }
    };
  }

  async pollOpenAiDeviceCode(request) {
    if (request.method !== "POST") {
      return errorResponse("method_not_allowed", 405);
    }
    const session = await this.state.storage.get(SESSION_KEY);
    if (!session || session.authType !== "openai-oauth") {
      return errorResponse("capability_not_found", 404);
    }
    if (session.revoked) return errorResponse("capability_revoked", 403);
    if (Date.now() >= session.expiresAt) {
      return errorResponse("capability_expired", 403);
    }
    if (session.state === "ready") {
      return errorResponse("authorization_already_consumed", 409);
    }
    const candidateDigest = await secretDigest(bearerToken(request));
    if (!fixedLengthEqual(candidateDigest, session.pollDigest ?? "")) {
      return errorResponse("unauthorized", 401);
    }
    if (Date.now() < session.nextPollAt) {
      return jsonResponse({
        schemaVersion: 1,
        status: "authorization_pending",
        retryAfterMs: session.nextPollAt - Date.now()
      }, 202);
    }

    let response;
    try {
      response = await this.oauthFetch()(
        `${OPENAI_AUTH_BASE_URL}/api/accounts/deviceauth/token`,
        {
          method: "POST",
          headers: openAiHeaders("application/json"),
          body: JSON.stringify({
            device_auth_id: session.deviceAuthId,
            user_code: session.userCode
          })
        }
      );
    } catch {
      return openAiError("openai_device_unreachable", 502);
    }
    const { value } = await readJsonResponse(response);
    if (response.status === 403 || response.status === 404) {
      session.nextPollAt = Date.now() + session.intervalMs;
      await this.state.storage.put(SESSION_KEY, session);
      return jsonResponse({
        schemaVersion: 1,
        status: "authorization_pending",
        retryAfterMs: session.intervalMs
      }, 202);
    }
    const authorizationCode = typeof value.authorization_code === "string"
      ? value.authorization_code.trim()
      : "";
    const codeVerifier = typeof value.code_verifier === "string"
      ? value.code_verifier.trim()
      : "";
    if (!response.ok || !authorizationCode || !codeVerifier) {
      return openAiError(
        "openai_device_authorization_failed",
        502
      );
    }

    const exchanged = await this.exchangeOpenAiDeviceAuthorization(
      authorizationCode,
      codeVerifier
    );
    if (exchanged.error) return exchanged.error;
    const guestSecret = randomSecret();
    const now = Date.now();
    const expiresAt = now + DEFAULT_TTL_SECONDS * 1_000;
    const readySession = {
      ...session,
      ...exchanged.credentials,
      state: "ready",
      guestDigest: await secretDigest(guestSecret),
      pollDigest: null,
      deviceAuthId: null,
      userCode: null,
      expiresAt,
      authorizedAt: now
    };
    await this.state.storage.put(SESSION_KEY, readySession);
    await this.state.storage.setAlarm?.(expiresAt);
    return jsonResponse({
      schemaVersion: 1,
      status: "ready",
      capability: {
        token: guestSecret,
        provider: readySession.provider,
        providerLabel: readySession.providerLabel,
        model: readySession.model,
        apiPath: readySession.apiPath,
        modelApi: readySession.modelApi,
        openClawProvider: readySession.openClawProvider,
        expiresAt: new Date(expiresAt).toISOString(),
        maxRequests: readySession.maxRequests
      }
    });
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
      authType: "api-key",
      state: "ready",
      apiKey: input.apiKey,
      provider: input.provider,
      providerLabel: provider.label,
      apiPath: provider.apiPath,
      modelApi: provider.modelApi,
      openClawProvider: provider.openClawProvider,
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
        apiPath: provider.apiPath,
        modelApi: provider.modelApi,
        openClawProvider: provider.openClawProvider,
        model: input.model,
        expiresAt: new Date(expiresAt).toISOString(),
        maxRequests: DEFAULT_MAX_REQUESTS
      }
    }, 201);
  }

  async refreshOpenAiCredential(session) {
    if (
      session.authType !== "openai-oauth"
      || session.tokenExpiresAt - Date.now() > OPENAI_REFRESH_SKEW_MS
    ) {
      return { session };
    }
    let response;
    try {
      response = await this.oauthFetch()(
        `${OPENAI_AUTH_BASE_URL}/oauth/token`,
        {
          method: "POST",
          headers: openAiHeaders("application/x-www-form-urlencoded"),
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: session.refreshToken,
            client_id: OPENAI_CODEX_CLIENT_ID
          })
        }
      );
    } catch {
      return { error: openAiError("openai_token_refresh_unreachable", 502) };
    }
    const { value } = await readJsonResponse(response);
    const accessToken = typeof value.access_token === "string"
      ? value.access_token.trim()
      : "";
    const refreshToken = typeof value.refresh_token === "string"
      ? value.refresh_token.trim()
      : session.refreshToken;
    if (!response.ok || !accessToken || !refreshToken) {
      return {
        error: openAiError(
          "openai_token_refresh_failed",
          502
        )
      };
    }
    const identity = resolveOpenAiIdentity(accessToken);
    const refreshed = {
      ...session,
      accessToken,
      refreshToken,
      accountId: identity.accountId ?? session.accountId,
      tokenExpiresAt:
        Date.now()
        + (
          positiveMillisecondsFromSeconds(value.expires_in)
          ?? Math.max(1_000, (identity.expiresAt ?? Date.now()) - Date.now())
        )
    };
    await this.state.storage.put(SESSION_KEY, refreshed);
    return { session: refreshed };
  }

  async forwardModelRequest(request, requestKind) {
    if (request.method !== "POST") {
      return errorResponse("method_not_allowed", 405);
    }
    const session = await this.state.storage.get(SESSION_KEY);
    if (!session) return errorResponse("capability_not_found", 404);
    if (
      session.revoked
      || session.state !== "ready"
      || (
        session.authType === "api-key"
          ? !session.apiKey
          : !session.accessToken || !session.refreshToken
      )
    ) {
      return errorResponse("capability_revoked", 403);
    }
    if (
      requestKind === "chat-completions"
        ? session.apiPath !== "/v1/chat/completions"
        : session.apiPath !== "/v1/responses"
    ) {
      return errorResponse("request_outside_capability", 400);
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
    const validRequest = requestKind === "responses"
      ? validateResponses(parsed.value, session.model)
      : validateCompletion(parsed.value, session.model);
    if (!validRequest) {
      return errorResponse("request_outside_capability", 400);
    }

    const reserveRequest = async () => {
      const current = await this.state.storage.get(SESSION_KEY);
      if (!current) return errorResponse("capability_not_found", 404);
      if (
        current.revoked
        || current.state !== "ready"
        || (
          current.authType === "api-key"
            ? !current.apiKey
            : !current.accessToken || !current.refreshToken
        )
      ) {
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
    const refreshCredential = async () => {
      const latest = await this.state.storage.get(SESSION_KEY);
      return this.refreshOpenAiCredential(latest ?? reserved);
    };
    const refreshed = this.state.blockConcurrencyWhile
      ? await this.state.blockConcurrencyWhile(refreshCredential)
      : await refreshCredential();
    if (refreshed.error) return refreshed.error;
    const active = refreshed.session;
    if (
      active.revoked
      || (
        active.authType === "api-key"
          ? !active.apiKey
          : !active.accessToken || !active.refreshToken
      )
    ) {
      return errorResponse("capability_revoked", 403);
    }
    const provider = BYOK_PROVIDERS[active.provider];
    const headers = new Headers({
      Accept: parsed.value.stream === true
        ? "text/event-stream"
        : "application/json",
      Authorization: `Bearer ${
        active.authType === "openai-oauth"
          ? active.accessToken
          : active.apiKey
      }`,
      "Content-Type": "application/json",
      "User-Agent": active.authType === "openai-oauth"
        ? `openclaw/${OPENCLAW_VERSION}`
        : "Clawsembly-BYOK/0.1"
    });
    let upstreamUrl = provider?.upstream;
    let upstreamBody = parsed.bytes;
    if (active.authType === "openai-oauth") {
      upstreamUrl = OPENAI_CODEX_RESPONSES_URL;
      headers.set("ChatGPT-Account-Id", active.accountId);
      headers.set("originator", "openclaw");
      headers.set("version", OPENCLAW_VERSION);
      upstreamBody = new TextEncoder().encode(JSON.stringify(
        sanitizeCodexResponses(parsed.value)
      ));
    } else if (active.provider === "openrouter") {
      headers.set("HTTP-Referer", "https://clawsembly.yhay81.com/");
      headers.set("X-Title", "Clawsembly");
    }

    let upstream;
    try {
      const providerFetch = this.env.BYOK_PROVIDER_FETCH ?? fetch;
      upstream = await providerFetch(upstreamUrl, {
        method: "POST",
        headers,
        body: upstreamBody
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
    session.accessToken = null;
    session.refreshToken = null;
    session.deviceAuthId = null;
    session.userCode = null;
    session.pollDigest = null;
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
