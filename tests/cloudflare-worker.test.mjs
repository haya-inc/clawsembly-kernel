import assert from "node:assert/strict";
import test from "node:test";
import worker, {
  resetRuntimeManifestCache,
  resolveRuntimeArtifact,
  validateRuntimeManifest
} from "../worker/index.mjs";

const edgeSha256 = "a".repeat(64);
const imageSha256 = "b".repeat(64);
const manifest = {
  schemaVersion: 1,
  release: "v0.1.0-alpha.1",
  sourceCommit: "c".repeat(40),
  generatedAt: "2026-07-29T00:00:00.000Z",
  openclaw: {
    version: "2026.7.1-2"
  },
  nodeCompatibility: {
    version: "v24.15.0"
  },
  proof: {
    runUrl:
      "https://github.com/haya-inc/clawsembly-kernel/actions/runs/1"
  },
  artifacts: {
    edgejs: {
      aliasPath: "/edgejs.wasm",
      publicPath: "/runtime/v0.1.0-alpha.1/edgejs.wasm",
      r2Key: `sha256/${edgeSha256}/edgejs.wasm`,
      bytes: 32,
      sha256: edgeSha256,
      contentType: "application/wasm"
    },
    openclaw: {
      aliasPath: "/openclaw.clawfs",
      publicPath: "/runtime/v0.1.0-alpha.1/openclaw.clawfs",
      r2Key: `sha256/${imageSha256}/openclaw.clawfs`,
      bytes: 48,
      sha256: imageSha256,
      contentType: "application/octet-stream"
    }
  }
};

function createCache() {
  const entries = new Map();
  return {
    async match(request) {
      const response = entries.get(request.url);
      return response?.clone();
    },
    async put(request, response) {
      entries.set(request.url, response.clone());
    }
  };
}

function createEnvironment() {
  const edgeBytes = new Uint8Array(32).map((_, index) => index);
  const imageBytes = new Uint8Array(48).fill(7);
  const objects = new Map([
    [manifest.artifacts.edgejs.r2Key, edgeBytes],
    [manifest.artifacts.openclaw.r2Key, imageBytes]
  ]);
  const calls = {
    get: 0,
    head: 0
  };
  const toObject = (key, bytes, range) => {
    const selected = range
      ? bytes.slice(range.offset, range.offset + range.length)
      : bytes;
    return {
      key,
      size: bytes.byteLength,
      body: selected,
      ...(range ? { range } : {}),
      writeHttpMetadata(headers) {
        headers.set("Last-Modified", "Wed, 29 Jul 2026 00:00:00 GMT");
      }
    };
  };
  return {
    calls,
    env: {
      ASSETS: {
        async fetch(request) {
          const pathname = new URL(request.url).pathname;
          if (pathname === "/runtime-manifest.json") {
            return Response.json(manifest);
          }
          return new Response("<!doctype html><title>Clawsembly</title>", {
            headers: {
              "Content-Type": "text/html; charset=utf-8"
            }
          });
        }
      },
      RUNTIME_BUCKET: {
        async head(key) {
          calls.head += 1;
          const bytes = objects.get(key);
          return bytes ? toObject(key, bytes) : null;
        },
        async get(key, options) {
          calls.get += 1;
          const bytes = objects.get(key);
          if (!bytes) return null;
          const header = options?.range?.get("Range");
          const match = /^bytes=([0-9]+)-([0-9]+)$/u.exec(header ?? "");
          const range = match
            ? {
                offset: Number(match[1]),
                length: Number(match[2]) - Number(match[1]) + 1
              }
            : undefined;
          return toObject(key, bytes, range);
        }
      }
    }
  };
}

function createContext() {
  const promises = [];
  return {
    promises,
    waitUntil(promise) {
      promises.push(promise);
    }
  };
}

test.beforeEach(() => {
  resetRuntimeManifestCache();
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: createCache()
    }
  });
});

test.afterEach(() => {
  delete globalThis.caches;
});

test("validates and resolves only content-addressed runtime artifacts", () => {
  assert.equal(validateRuntimeManifest(manifest), manifest);
  assert.equal(
    resolveRuntimeArtifact(manifest, "/edgejs.wasm"),
    manifest.artifacts.edgejs
  );
  assert.equal(
    resolveRuntimeArtifact(
      manifest,
      "/runtime/v0.1.0-alpha.1/openclaw.clawfs"
    ),
    manifest.artifacts.openclaw
  );
  assert.equal(resolveRuntimeArtifact(manifest, "/missing"), undefined);
  assert.throws(
    () => validateRuntimeManifest({
      ...manifest,
      artifacts: {
        ...manifest.artifacts,
        edgejs: {
          ...manifest.artifacts.edgejs,
          r2Key: "mutable/edgejs.wasm"
        }
      }
    }),
    /Invalid edgejs runtime artifact manifest/u
  );
});

test("serves the app and health endpoint with cross-origin isolation", async () => {
  const { env } = createEnvironment();
  const context = createContext();
  const appResponse = await worker.fetch(
    new Request("https://clawsembly.yhay81.com/"),
    env,
    context
  );
  assert.equal(appResponse.status, 200);
  assert.equal(
    appResponse.headers.get("Cross-Origin-Opener-Policy"),
    "same-origin"
  );
  assert.equal(
    appResponse.headers.get("Cross-Origin-Embedder-Policy"),
    "require-corp"
  );
  assert.equal(appResponse.headers.get("Cache-Control"), "no-cache");

  const healthResponse = await worker.fetch(
    new Request("https://clawsembly.yhay81.com/healthz"),
    env,
    context
  );
  assert.deepEqual(await healthResponse.json(), {
    schemaVersion: 1,
    status: "ok",
    service: "clawsembly-kernel"
  });
});

test("streams and caches a full runtime object under its canonical URL", async () => {
  const { calls, env } = createEnvironment();
  const firstContext = createContext();
  const first = await worker.fetch(
    new Request("https://clawsembly.yhay81.com/edgejs.wasm"),
    env,
    firstContext
  );
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("Content-Type"), "application/wasm");
  assert.equal(first.headers.get("Content-Length"), "32");
  assert.equal(first.headers.get("X-Clawsembly-SHA256"), edgeSha256);
  assert.equal(
    first.headers.get("ETag"),
    `"sha256-${edgeSha256}"`
  );
  assert.deepEqual(new Uint8Array(await first.arrayBuffer()), new Uint8Array(32)
    .map((_, index) => index));
  await Promise.all(firstContext.promises);

  const secondContext = createContext();
  const second = await worker.fetch(
    new Request(
      "https://clawsembly.yhay81.com"
      + "/runtime/v0.1.0-alpha.1/edgejs.wasm"
    ),
    env,
    secondContext
  );
  assert.equal(second.status, 200);
  assert.equal((await second.arrayBuffer()).byteLength, 32);
  assert.equal(calls.get, 1);
});

test("supports HEAD, conditional GET, byte ranges, and method denial", async () => {
  const { env } = createEnvironment();
  const context = createContext();
  const url =
    "https://clawsembly.yhay81.com"
    + "/runtime/v0.1.0-alpha.1/openclaw.clawfs";

  const head = await worker.fetch(
    new Request(url, { method: "HEAD" }),
    env,
    context
  );
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("Content-Length"), "48");
  assert.equal((await head.arrayBuffer()).byteLength, 0);

  const notModified = await worker.fetch(
    new Request(url, {
      headers: {
        "If-None-Match": `"sha256-${imageSha256}"`
      }
    }),
    env,
    context
  );
  assert.equal(notModified.status, 304);

  const range = await worker.fetch(
    new Request(url, {
      headers: {
        Range: "bytes=4-11"
      }
    }),
    env,
    context
  );
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("Content-Range"), "bytes 4-11/48");
  assert.equal((await range.arrayBuffer()).byteLength, 8);

  const denied = await worker.fetch(
    new Request(url, { method: "POST" }),
    env,
    context
  );
  assert.equal(denied.status, 405);
  assert.equal(denied.headers.get("Allow"), "GET, HEAD");
});
