import type { ByokCapabilityHandoff } from "./byok-capability-handoff";

type DirectoryEntry = {
  name: string;
  type: "file" | "dir" | "unknown";
};

export type ByokBridgeDirectory = {
  readDir(path: string): Promise<DirectoryEntry[]>;
  readFile(path: string): Promise<Uint8Array>;
  removeFile(path: string): Promise<void>;
  writeFile(path: string, contents: string | Uint8Array): Promise<void>;
};

type BridgeRequest = {
  authorization: string;
  body: string;
  id: string;
  method: "POST";
  path: "/v1/chat/completions" | "/v1/responses";
  schemaVersion: 1;
};

type BridgeResponse = {
  bodyBase64: string;
  headers: Record<string, string>;
  schemaVersion: 1;
  status: number;
};

export type ByokHttpBridgeSnapshot = {
  failed: number;
  forwarded: number;
  providerCredentialRecorded: false;
  requestsSeen: number;
};

export type ByokHttpBridge = {
  done: Promise<void>;
  snapshot(): ByokHttpBridgeSnapshot;
  stop(): Promise<void>;
};

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const requestDirectory = "/requests";
const responseDirectory = "/responses";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, milliseconds);
  });
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  const chunkBytes = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkBytes)
    );
  }
  return btoa(binary);
}

function fixedLengthEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function parseRequest(
  bytes: Uint8Array,
  capability: ByokCapabilityHandoff
): BridgeRequest {
  const value = JSON.parse(decoder.decode(bytes)) as Partial<BridgeRequest>;
  if (
    value.schemaVersion !== 1
    || value.method !== "POST"
    || value.path !== capability.apiPath
    || typeof value.id !== "string"
    || !/^[A-Za-z0-9_-]{1,128}$/u.test(value.id)
    || typeof value.authorization !== "string"
    || typeof value.body !== "string"
    || encoder.encode(value.body).byteLength > MAX_BODY_BYTES
  ) {
    throw new Error("invalid_bridge_request");
  }
  const body = JSON.parse(value.body) as {
    input?: unknown;
    messages?: unknown;
    model?: unknown;
  };
  const validPayload = capability.apiPath === "/v1/responses"
    ? Array.isArray(body.input)
    : Array.isArray(body.messages);
  if (body.model !== capability.model || !validPayload) {
    throw new Error("request_outside_capability");
  }
  return value as BridgeRequest;
}

function errorBridgeResponse(code: string, status: number): BridgeResponse {
  return {
    schemaVersion: 1,
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json"
    },
    bodyBase64: base64(encoder.encode(JSON.stringify({
      error: {
        code,
        type: "clawsembly_bridge_error"
      }
    })))
  };
}
async function writeResponse(
  directory: ByokBridgeDirectory,
  id: string,
  response: BridgeResponse
): Promise<void> {
  await directory.writeFile(
    `${responseDirectory}/${id}.json`,
    JSON.stringify(response)
  );
}

export function startByokHttpBridge(options: {
  capability: ByokCapabilityHandoff;
  directory: ByokBridgeDirectory;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
}): ByokHttpBridge {
  const {
    capability,
    directory,
    fetchImpl = fetch,
    pollIntervalMs = 20
  } = options;
  let stopped = false;
  const stats = {
    failed: 0,
    forwarded: 0,
    providerCredentialRecorded: false as const,
    requestsSeen: 0
  };

  const processRequest = async (entry: DirectoryEntry): Promise<void> => {
    if (
      entry.type !== "file"
      || !entry.name.endsWith(".json")
      || !/^[A-Za-z0-9_-]{1,128}\.json$/u.test(entry.name)
    ) {
      return;
    }
    const requestPath = `${requestDirectory}/${entry.name}`;
    const id = entry.name.slice(0, -".json".length);
    let request: BridgeRequest;
    stats.requestsSeen += 1;
    try {
      request = parseRequest(
        await directory.readFile(requestPath),
        capability
      );
      if (request.id !== id) throw new Error("request_id_mismatch");
      const expectedAuthorization = `Bearer ${capability.apiKey}`;
      if (
        !fixedLengthEqual(request.authorization, expectedAuthorization)
      ) {
        throw new Error("unauthorized");
      }
    } catch (error) {
      stats.failed += 1;
      const code = error instanceof Error ? error.message : "invalid_request";
      await writeResponse(
        directory,
        id,
        errorBridgeResponse(code, code === "unauthorized" ? 401 : 400)
      );
      await directory.removeFile(requestPath);
      return;
    }

    let bridgeResponse: BridgeResponse;
    try {
      const upstream = await fetchImpl(
        `${capability.baseUrl}${capability.apiPath.slice("/v1".length)}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${capability.apiKey}`,
            "Content-Type": "application/json"
          },
          body: request.body
        }
      );
      const body = new Uint8Array(await upstream.arrayBuffer());
      if (body.byteLength > MAX_BODY_BYTES) {
        throw new Error("response_too_large");
      }
      const contentType = upstream.headers.get("Content-Type");
      bridgeResponse = {
        schemaVersion: 1,
        status: upstream.status,
        headers: {
          "cache-control": "no-store",
          ...(contentType ? { "content-type": contentType } : {})
        },
        bodyBase64: base64(body)
      };
      stats.forwarded += 1;
    } catch (error) {
      stats.failed += 1;
      bridgeResponse = errorBridgeResponse(
        error instanceof Error ? error.message : "provider_unreachable",
        502
      );
    }
    await writeResponse(directory, id, bridgeResponse);
    await directory.removeFile(requestPath);
  };

  const done = (async () => {
    while (!stopped) {
      try {
        const entries = await directory.readDir(requestDirectory);
        for (const entry of entries) {
          if (stopped) break;
          await processRequest(entry);
        }
      } catch {
        // The guest can be between its atomic temporary write and rename.
      }
      if (!stopped) await sleep(pollIntervalMs);
    }
  })();

  return {
    done,
    snapshot: () => ({ ...stats }),
    stop: async () => {
      stopped = true;
      await done;
    }
  };
}
