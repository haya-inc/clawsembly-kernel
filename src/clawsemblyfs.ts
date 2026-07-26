const MAGIC = new TextEncoder().encode("CLAWSEMBLYFS1\n");
const VERSION = 1;
const PREAMBLE_BYTES = MAGIC.byteLength + 8;
const ENTRY_HEADER_BYTES = 16;
const MAX_FILES = 100_000;
const MAX_PATH_BYTES = 16 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

export type ClawsemblyFsImage = {
  files: Record<string, Uint8Array>;
  fileCount: number;
  payloadBytes: number;
  version: number;
};

function requireBytes(
  bytes: Uint8Array,
  offset: number,
  length: number,
  label: string
): void {
  if (
    !Number.isSafeInteger(offset)
    || !Number.isSafeInteger(length)
    || offset < 0
    || length < 0
    || offset + length > bytes.byteLength
  ) {
    throw new Error(`Truncated ClawsemblyFS ${label}`);
  }
}

function validatePath(value: string): void {
  if (
    !value.startsWith("/")
    || value === "/"
    || value.includes("\u0000")
    || value.includes("\\")
    || value.endsWith("/")
  ) {
    throw new Error(`Invalid ClawsemblyFS path: ${JSON.stringify(value)}`);
  }
  const segments = value.slice(1).split("/");
  if (
    segments.some((segment) => (
      segment.length === 0 || segment === "." || segment === ".."
    ))
  ) {
    throw new Error(`Unsafe ClawsemblyFS path: ${JSON.stringify(value)}`);
  }
}

export function parseClawsemblyFs(bytes: Uint8Array): ClawsemblyFsImage {
  requireBytes(bytes, 0, PREAMBLE_BYTES, "preamble");
  for (let index = 0; index < MAGIC.byteLength; index += 1) {
    if (bytes[index] !== MAGIC[index]) {
      throw new Error("Invalid ClawsemblyFS magic");
    }
  }

  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength
  );
  const version = view.getUint32(MAGIC.byteLength);
  if (version !== VERSION) {
    throw new Error(`Unsupported ClawsemblyFS version: ${version}`);
  }
  const fileCount = view.getUint32(MAGIC.byteLength + 4);
  if (fileCount > MAX_FILES) {
    throw new Error(`ClawsemblyFS file count exceeds ${MAX_FILES}`);
  }

  const files = {} as Record<string, Uint8Array>;
  let offset = PREAMBLE_BYTES;
  let payloadBytes = 0;
  for (let index = 0; index < fileCount; index += 1) {
    requireBytes(bytes, offset, ENTRY_HEADER_BYTES, `entry ${index} header`);
    const pathLength = view.getUint32(offset);
    const contentLength = view.getBigUint64(offset + 8);
    offset += ENTRY_HEADER_BYTES;
    if (pathLength === 0 || pathLength > MAX_PATH_BYTES) {
      throw new Error(
        `Invalid ClawsemblyFS path length at entry ${index}: ${pathLength}`
      );
    }
    if (contentLength > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`ClawsemblyFS entry ${index} is too large`);
    }
    const safeContentLength = Number(contentLength);
    requireBytes(bytes, offset, pathLength, `entry ${index} path`);
    const filePath = decoder.decode(bytes.subarray(offset, offset + pathLength));
    validatePath(filePath);
    offset += pathLength;
    requireBytes(bytes, offset, safeContentLength, `entry ${index} content`);
    if (Object.hasOwn(files, filePath)) {
      throw new Error(`Duplicate ClawsemblyFS path: ${filePath}`);
    }
    Object.defineProperty(files, filePath, {
      configurable: false,
      enumerable: true,
      value: bytes.subarray(offset, offset + safeContentLength),
      writable: false
    });
    offset += safeContentLength;
    payloadBytes += safeContentLength;
  }
  if (offset !== bytes.byteLength) {
    throw new Error(
      `ClawsemblyFS has ${bytes.byteLength - offset} trailing bytes`
    );
  }
  return {
    files,
    fileCount,
    payloadBytes,
    version
  };
}
