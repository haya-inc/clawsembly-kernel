const KEY_PATTERN =
  /^sha256\/[a-f0-9]{64}\/(?:edgejs\.wasm|openclaw\.clawfs)$/u;
const ALLOWED_CONTENT_TYPES = new Set([
  "application/wasm",
  "application/octet-stream"
]);

function json(value, status = 200) {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function requireAuthorized(request, env) {
  const token = env.CLAWSEMBLY_UPLOAD_TOKEN;
  return (
    typeof token === "string"
    && token.length >= 32
    && request.headers.get("Authorization") === `Bearer ${token}`
  );
}

function requireKey(value) {
  if (typeof value !== "string" || !KEY_PATTERN.test(value)) {
    throw new Error("Invalid content-addressed R2 key");
  }
  return value;
}

function requireUploadId(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 1024
  ) {
    throw new Error("Invalid multipart upload identifier");
  }
  return value;
}

function requireParts(value) {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.length > 10_000
    || value.some((part, index) => (
      !part
      || typeof part !== "object"
      || part.partNumber !== index + 1
      || typeof part.etag !== "string"
      || part.etag.length === 0
    ))
  ) {
    throw new Error("Invalid ordered multipart completion list");
  }
  return value;
}

async function handleRequest(request, env) {
  if (!requireAuthorized(request, env)) {
    return json({ error: "forbidden" }, 403);
  }
  const url = new URL(request.url);

  if (url.pathname === "/create" && request.method === "POST") {
    const body = await request.json();
    const key = requireKey(body.key);
    if (!ALLOWED_CONTENT_TYPES.has(body.contentType)) {
      throw new Error("Invalid runtime artifact content type");
    }
    const upload = await env.RUNTIME_BUCKET.createMultipartUpload(key, {
      httpMetadata: {
        contentType: body.contentType,
        cacheControl: "public, max-age=31536000, immutable"
      }
    });
    return json({
      key: upload.key,
      uploadId: upload.uploadId
    });
  }

  if (url.pathname === "/part" && request.method === "PUT") {
    const key = requireKey(url.searchParams.get("key"));
    const uploadId = requireUploadId(url.searchParams.get("uploadId"));
    const partNumber = Number(url.searchParams.get("partNumber"));
    if (
      !Number.isSafeInteger(partNumber)
      || partNumber < 1
      || partNumber > 10_000
      || !request.body
    ) {
      throw new Error("Invalid multipart part request");
    }
    const upload = env.RUNTIME_BUCKET.resumeMultipartUpload(key, uploadId);
    return json(await upload.uploadPart(partNumber, request.body));
  }

  if (url.pathname === "/complete" && request.method === "POST") {
    const body = await request.json();
    const key = requireKey(body.key);
    const uploadId = requireUploadId(body.uploadId);
    const parts = requireParts(body.parts);
    const upload = env.RUNTIME_BUCKET.resumeMultipartUpload(key, uploadId);
    const object = await upload.complete(parts);
    return json({
      key: object.key,
      size: object.size,
      etag: object.httpEtag
    });
  }

  if (url.pathname === "/abort" && request.method === "POST") {
    const body = await request.json();
    const key = requireKey(body.key);
    const uploadId = requireUploadId(body.uploadId);
    const upload = env.RUNTIME_BUCKET.resumeMultipartUpload(key, uploadId);
    await upload.abort();
    return new Response(null, {
      status: 204,
      headers: {
        "Cache-Control": "no-store"
      }
    });
  }

  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      return json({
        error: error instanceof Error ? error.message : String(error)
      }, 400);
    }
  }
};
