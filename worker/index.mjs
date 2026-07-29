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
