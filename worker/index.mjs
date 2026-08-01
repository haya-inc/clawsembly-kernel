import { ByokCapabilityBroker } from "./byok-broker.mjs";

const SECURITY_HEADERS = Object.freeze({
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Origin-Agent-Cluster": "?1",
  "Permissions-Policy": "cross-origin-isolated=(self)",
  "X-Content-Type-Options": "nosniff"
});

const IMMUTABLE_CACHE_CONTROL =
  "public, max-age=31536000, s-maxage=31536000, immutable, no-transform";
const MANIFEST_PATH = "/runtime-manifest.json";
let manifestPromise;

const BYOK_ISSUE_PATH = "/api/byok/capabilities";
const BYOK_COMPLETION_PATH = "/api/byok/v1/chat/completions";
const BYOK_RESPONSES_PATH = "/api/byok/v1/responses";
const BYOK_REVOKE_PATH = "/api/byok/capabilities/revoke";
const OPENAI_DEVICE_START_PATH = "/api/oauth/openai/device/start";
const OPENAI_DEVICE_POLL_PATH = "/api/oauth/openai/device/poll";

function applySecurityHeaders(headers) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
}

function withSecurityHeaders(response, pathname) {
  const headers = new Headers(response.headers);
  applySecurityHeaders(headers);
  if (pathname.startsWith("/assets/")) {
    headers.set("Cache-Control", IMMUTABLE_CACHE_CONTROL);
  } else if (
    pathname === "/"
    || pathname.endsWith(".html")
    || pathname === MANIFEST_PATH
  ) {
    headers.set("Cache-Control", "no-cache");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function noStoreResponse(response) {
  const headers = new Headers(response.headers);
  applySecurityHeaders(headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function byokError(code, status) {
  return noStoreResponse(Response.json({
    schemaVersion: 1,
    status: "error",
    error: { code }
  }, { status }));
}

function isSameOriginBrowserRequest(request) {
  const origin = request.headers.get("Origin");
  return !origin || origin === new URL(request.url).origin;
}

function parseRoutedCapability(request) {
  const authorization = request.headers.get("Authorization");
  const value = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  const separator = value.indexOf(".");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  const id = value.slice(0, separator);
  const secret = value.slice(separator + 1);
  if (
    !/^[a-f0-9]{64}$/u.test(id)
    || !/^[A-Za-z0-9_-]{32,128}$/u.test(secret)
  ) {
    return undefined;
  }
  return { id, secret };
}

async function issueByokCapability(request, env) {
  if (request.method !== "POST") {
    return byokError("method_not_allowed", 405);
  }
  if (!isSameOriginBrowserRequest(request)) {
    return byokError("cross_origin_denied", 403);
  }
  if (!env.BYOK_BROKERS) {
    return byokError("byok_broker_unavailable", 503);
  }
  const id = env.BYOK_BROKERS.newUniqueId();
  const response = await env.BYOK_BROKERS.get(id).fetch(
    new Request("https://byok.internal/issue", {
      method: "POST",
      headers: {
        "Content-Type": request.headers.get("Content-Type")
          ?? "application/octet-stream"
      },
      body: await request.arrayBuffer()
    })
  );
  if (!response.ok) return noStoreResponse(response);
  const body = await response.json();
  const sessionId = id.toString();
  return noStoreResponse(Response.json({
    ...body,
    capability: {
      ...body.capability,
      token: `${sessionId}.${body.capability.token}`,
      adminToken: `${sessionId}.${body.capability.adminToken}`,
      baseUrl: `${new URL(request.url).origin}/api/byok/v1`,
      providerId: "clawsembly-byok"
    }
  }, { status: response.status }));
}

async function startOpenAiDeviceAuthorization(request, env) {
  if (request.method !== "POST") {
    return byokError("method_not_allowed", 405);
  }
  if (!isSameOriginBrowserRequest(request)) {
    return byokError("cross_origin_denied", 403);
  }
  if (!env.BYOK_BROKERS) {
    return byokError("byok_broker_unavailable", 503);
  }
  const id = env.BYOK_BROKERS.newUniqueId();
  const response = await env.BYOK_BROKERS.get(id).fetch(
    new Request("https://byok.internal/oauth/openai/device/start", {
      method: "POST",
      headers: {
        "Content-Type": request.headers.get("Content-Type")
          ?? "application/octet-stream"
      },
      body: await request.arrayBuffer()
    })
  );
  if (!response.ok) return noStoreResponse(response);
  const body = await response.json();
  const sessionId = id.toString();
  return noStoreResponse(Response.json({
    ...body,
    pollToken: `${sessionId}.${body.pollToken}`,
    adminToken: `${sessionId}.${body.adminToken}`,
    pollUrl: `${new URL(request.url).origin}${OPENAI_DEVICE_POLL_PATH}`
  }, { status: response.status }));
}

async function routeByokCapability(request, env, pathname) {
  if (request.method !== "POST") {
    return byokError("method_not_allowed", 405);
  }
  if (!env.BYOK_BROKERS) {
    return byokError("byok_broker_unavailable", 503);
  }
  const capability = parseRoutedCapability(request);
  if (!capability) return byokError("unauthorized", 401);
  let id;
  try {
    id = env.BYOK_BROKERS.idFromString(capability.id);
  } catch {
    return byokError("unauthorized", 401);
  }
  const body = pathname === "/v1/chat/completions"
    || pathname === "/v1/responses"
    ? await request.arrayBuffer()
    : undefined;
  const response = await env.BYOK_BROKERS.get(id).fetch(
    new Request(`https://byok.internal${pathname}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${capability.secret}`,
        ...(body
          ? {
              "Content-Type": request.headers.get("Content-Type")
                ?? "application/octet-stream"
            }
          : {})
      },
      ...(body ? { body } : {})
    })
  );
  if (
    pathname === "/oauth/openai/device/poll"
    && response.ok
    && response.status !== 202
  ) {
    const payload = await response.json();
    if (payload.status === "ready" && payload.capability?.token) {
      return noStoreResponse(Response.json({
        ...payload,
        capability: {
          ...payload.capability,
          token: `${capability.id}.${payload.capability.token}`,
          baseUrl: `${new URL(request.url).origin}/api/byok/v1`,
          providerId: "clawsembly-byok"
        }
      }, { status: response.status }));
    }
  }
  return noStoreResponse(response);
}

function isHexSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

export function validateRuntimeManifest(value) {
  if (
    !value
    || typeof value !== "object"
    || value.schemaVersion !== 1
    || typeof value.release !== "string"
    || value.release.length === 0
    || typeof value.sourceCommit !== "string"
    || !/^[a-f0-9]{40}$/u.test(value.sourceCommit)
    || !value.artifacts
    || typeof value.artifacts !== "object"
  ) {
    throw new Error("Invalid Clawsembly runtime manifest");
  }
  for (const name of ["edgejs", "openclaw"]) {
    const artifact = value.artifacts[name];
    if (
      !artifact
      || typeof artifact !== "object"
      || typeof artifact.aliasPath !== "string"
      || typeof artifact.publicPath !== "string"
      || typeof artifact.r2Key !== "string"
      || typeof artifact.contentType !== "string"
      || !Number.isSafeInteger(artifact.bytes)
      || artifact.bytes <= 0
      || !isHexSha256(artifact.sha256)
      || !artifact.r2Key.includes(artifact.sha256)
    ) {
      throw new Error(`Invalid ${name} runtime artifact manifest`);
    }
  }
  return value;
}

async function loadRuntimeManifest(env, request) {
  manifestPromise ??= (async () => {
    const manifestUrl = new URL(MANIFEST_PATH, request.url);
    const response = await env.ASSETS.fetch(
      new Request(manifestUrl, {
        headers: {
          Accept: "application/json"
        }
      })
    );
    if (!response.ok) {
      throw new Error(
        `Runtime manifest fetch failed with HTTP ${response.status}`
      );
    }
    return validateRuntimeManifest(await response.json());
  })();
  try {
    return await manifestPromise;
  } catch (error) {
    manifestPromise = undefined;
    throw error;
  }
}

export function resetRuntimeManifestCache() {
  manifestPromise = undefined;
}

export function resolveRuntimeArtifact(manifest, pathname) {
  for (const artifact of Object.values(manifest.artifacts)) {
    if (
      pathname === artifact.aliasPath
      || pathname === artifact.publicPath
    ) {
      return artifact;
    }
  }
  return undefined;
}

function quotedSha256Etag(artifact) {
  return `"sha256-${artifact.sha256}"`;
}

function contentDigest(artifact) {
  const bytes = artifact.sha256.match(/../gu)
    .map((value) => Number.parseInt(value, 16));
  const binary = String.fromCharCode(...bytes);
  return `sha-256=:${btoa(binary)}:`;
}

function runtimeHeaders(artifact, manifest, object) {
  const headers = new Headers();
  object.writeHttpMetadata?.(headers);
  applySecurityHeaders(headers);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", IMMUTABLE_CACHE_CONTROL);
  headers.set("Content-Digest", contentDigest(artifact));
  headers.set("Content-Type", artifact.contentType);
  headers.set("ETag", quotedSha256Etag(artifact));
  headers.set("X-Clawsembly-Release", manifest.release);
  headers.set("X-Clawsembly-SHA256", artifact.sha256);
  return headers;
}

function validateObject(artifact, object) {
  if (object.size !== artifact.bytes) {
    throw new Error(
      `R2 object size mismatch for ${artifact.r2Key}: `
      + `expected ${artifact.bytes}, received ${object.size}`
    );
  }
}

function ifNoneMatchSatisfied(request, artifact) {
  const value = request.headers.get("If-None-Match");
  if (!value) return false;
  return value
    .split(",")
    .map((entry) => entry.trim())
    .some((entry) => entry === "*" || entry === quotedSha256Etag(artifact));
}

function normalizedRange(object) {
  const range = object.range;
  if (
    !range
    || !Number.isSafeInteger(range.offset)
    || !Number.isSafeInteger(range.length)
  ) {
    return undefined;
  }
  return {
    offset: range.offset,
    length: range.length
  };
}

async function serveRuntimeArtifact(request, env, context, manifest, artifact) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    const headers = new Headers({
      Allow: "GET, HEAD"
    });
    applySecurityHeaders(headers);
    return new Response("Method Not Allowed", {
      status: 405,
      headers
    });
  }

  if (ifNoneMatchSatisfied(request, artifact)) {
    const headers = runtimeHeaders(artifact, manifest, {});
    return new Response(null, {
      status: 304,
      headers
    });
  }

  const rangeRequested = request.headers.has("Range");
  const canonicalUrl = new URL(artifact.publicPath, request.url);
  const cacheKey = new Request(canonicalUrl, { method: "GET" });
  const defaultCache = globalThis.caches?.default;

  if (request.method === "GET" && !rangeRequested && defaultCache) {
    const cached = await defaultCache.match(cacheKey);
    if (cached) return cached;
  }

  if (request.method === "HEAD") {
    const object = await env.RUNTIME_BUCKET.head(artifact.r2Key);
    if (!object) return new Response("Runtime artifact not found", { status: 404 });
    validateObject(artifact, object);
    const headers = runtimeHeaders(artifact, manifest, object);
    headers.set("Content-Length", String(artifact.bytes));
    return new Response(null, { status: 200, headers });
  }

  const object = await env.RUNTIME_BUCKET.get(
    artifact.r2Key,
    rangeRequested
      ? { range: request.headers }
      : undefined
  );
  if (!object || !("body" in object)) {
    return new Response("Runtime artifact not found", { status: 404 });
  }
  validateObject(artifact, object);

  const range = normalizedRange(object);
  const headers = runtimeHeaders(artifact, manifest, object);
  if (rangeRequested && range) {
    headers.set("Content-Length", String(range.length));
    headers.set(
      "Content-Range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${artifact.bytes}`
    );
    return new Response(object.body, {
      status: 206,
      headers
    });
  }

  headers.set("Content-Length", String(artifact.bytes));
  const response = new Response(object.body, {
    status: 200,
    headers
  });
  if (defaultCache) {
    context.waitUntil(
      defaultCache.put(cacheKey, response.clone()).catch((error) => {
        console.error("Failed to cache immutable runtime artifact", error);
      })
    );
  }
  return response;
}

async function handleRequest(request, env, context) {
  const url = new URL(request.url);
  if (url.pathname === "/healthz") {
    const headers = new Headers({
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8"
    });
    applySecurityHeaders(headers);
    return new Response(
      JSON.stringify({
        schemaVersion: 1,
        status: "ok",
        service: "clawsembly-kernel"
      }),
      { headers }
    );
  }
  if (url.pathname === BYOK_ISSUE_PATH) {
    return issueByokCapability(request, env);
  }
  if (url.pathname === BYOK_COMPLETION_PATH) {
    return routeByokCapability(
      request,
      env,
      "/v1/chat/completions"
    );
  }
  if (url.pathname === BYOK_RESPONSES_PATH) {
    return routeByokCapability(request, env, "/v1/responses");
  }
  if (url.pathname === BYOK_REVOKE_PATH) {
    return routeByokCapability(request, env, "/revoke");
  }
  if (url.pathname === OPENAI_DEVICE_START_PATH) {
    return startOpenAiDeviceAuthorization(request, env);
  }
  if (url.pathname === OPENAI_DEVICE_POLL_PATH) {
    return routeByokCapability(
      request,
      env,
      "/oauth/openai/device/poll"
    );
  }

  const manifest = await loadRuntimeManifest(env, request);
  const artifact = resolveRuntimeArtifact(manifest, url.pathname);
  if (artifact) {
    return serveRuntimeArtifact(
      request,
      env,
      context,
      manifest,
      artifact
    );
  }

  return withSecurityHeaders(
    await env.ASSETS.fetch(request),
    url.pathname
  );
}

export default {
  async fetch(request, env, context) {
    try {
      return await handleRequest(request, env, context);
    } catch (error) {
      console.error("Clawsembly Worker request failed", error);
      const headers = new Headers({
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8"
      });
      applySecurityHeaders(headers);
      return new Response(
        JSON.stringify({
          schemaVersion: 1,
          status: "error",
          error: error instanceof Error
            ? error.message
            : String(error)
        }),
        {
          status: 500,
          headers
        }
      );
    }
  }
};

export { ByokCapabilityBroker };
