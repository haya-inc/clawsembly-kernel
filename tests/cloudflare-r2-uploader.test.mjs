import assert from "node:assert/strict";
import test from "node:test";
import uploader from "../worker/r2-uploader.mjs";

const token = "u".repeat(64);
const sha256 = "a".repeat(64);
const key = `sha256/${sha256}/openclaw.clawfs`;

function authorizedRequest(url, init = {}) {
  return new Request(url, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token}`
    }
  });
}

function createEnvironment() {
  const state = {
    created: undefined,
    uploaded: [],
    completed: undefined,
    aborted: false
  };
  const upload = {
    key,
    uploadId: "upload-1",
    async uploadPart(partNumber, body) {
      const bytes = await new Response(body).arrayBuffer();
      const part = {
        partNumber,
        etag: `etag-${partNumber}`
      };
      state.uploaded.push({
        ...part,
        bytes: bytes.byteLength
      });
      return part;
    },
    async complete(parts) {
      state.completed = parts;
      return {
        key,
        size: state.uploaded.reduce(
          (total, part) => total + part.bytes,
          0
        ),
        httpEtag: "\"complete\""
      };
    },
    async abort() {
      state.aborted = true;
    }
  };
  return {
    state,
    env: {
      CLAWSEMBLY_UPLOAD_TOKEN: token,
      RUNTIME_BUCKET: {
        async createMultipartUpload(createdKey, options) {
          state.created = {
            key: createdKey,
            options
          };
          return upload;
        },
        resumeMultipartUpload(resumedKey, uploadId) {
          assert.equal(resumedKey, key);
          assert.equal(uploadId, "upload-1");
          return upload;
        }
      }
    }
  };
}

test("rejects requests without the ephemeral deployment capability", async () => {
  const { env } = createEnvironment();
  const response = await uploader.fetch(
    new Request("https://uploader.example/create", {
      method: "POST",
      body: "{}"
    }),
    env
  );
  assert.equal(response.status, 403);
});

test("reports readiness only with the ephemeral deployment capability", async () => {
  const { env } = createEnvironment();
  const response = await uploader.fetch(
    authorizedRequest("https://uploader.example/healthz"),
    env
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok",
    service: "clawsembly-r2-uploader"
  });
});

test("rejects mutable or unexpected R2 object keys", async () => {
  const { env } = createEnvironment();
  const response = await uploader.fetch(
    authorizedRequest("https://uploader.example/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        key: "latest/openclaw.clawfs",
        contentType: "application/octet-stream"
      })
    }),
    env
  );
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /content-addressed/u);
});

test("creates, uploads, and completes an authenticated multipart object", async () => {
  const { env, state } = createEnvironment();
  const createResponse = await uploader.fetch(
    authorizedRequest("https://uploader.example/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        key,
        contentType: "application/octet-stream"
      })
    }),
    env
  );
  assert.equal(createResponse.status, 200);
  assert.deepEqual(await createResponse.json(), {
    key,
    uploadId: "upload-1"
  });
  assert.equal(
    state.created.options.httpMetadata.cacheControl,
    "public, max-age=31536000, immutable"
  );

  const partUrl = new URL("https://uploader.example/part");
  partUrl.searchParams.set("key", key);
  partUrl.searchParams.set("uploadId", "upload-1");
  partUrl.searchParams.set("partNumber", "1");
  const partResponse = await uploader.fetch(
    authorizedRequest(partUrl, {
      method: "PUT",
      body: new Uint8Array([1, 2, 3, 4])
    }),
    env
  );
  assert.deepEqual(await partResponse.json(), {
    partNumber: 1,
    etag: "etag-1"
  });

  const parts = [{
    partNumber: 1,
    etag: "etag-1"
  }];
  const completeResponse = await uploader.fetch(
    authorizedRequest("https://uploader.example/complete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        key,
        uploadId: "upload-1",
        parts
      })
    }),
    env
  );
  assert.deepEqual(await completeResponse.json(), {
    key,
    size: 4,
    etag: "\"complete\""
  });
  assert.deepEqual(state.completed, parts);
});
