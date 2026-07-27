import type { Directory } from "@wasmer/sdk";

const STORE_ROOT = "clawsembly-kernel";
const STORES_DIRECTORY = "directory-stores";
const GENERATIONS_DIRECTORY = "generations";
const PAYLOAD_DIRECTORY = "payload";
const HEAD_FILENAME = "HEAD.json";
const MANIFEST_FILENAME = "manifest.json";
const MAX_FILES = 20_000;
const MAX_PAYLOAD_BYTES = 512 * 1024 * 1024;
const MAX_PATH_LENGTH = 4_096;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

type SnapshotFile = {
  bytes: number;
  path: string;
  sha256: string;
};

type SnapshotManifest = {
  createdAt: string;
  directories: string[];
  files: SnapshotFile[];
  generationId: string;
  payloadBytes: number;
  rootPath: string;
  schemaVersion: 1;
  storeId: string;
};

type SnapshotHead = {
  generationId: string;
  manifestSha256: string;
  schemaVersion: 1;
};

export type OpfsStorageEvidence = {
  persistRequestError?: string;
  persistRequestGranted: boolean;
  persistRequestSupported: boolean;
  persistedAfter: boolean;
  persistedBefore: boolean;
  root: "origin-private-file-system";
};

export type OpfsDirectorySnapshotEvidence = {
  directories: number;
  files: number;
  generationId: string;
  manifestSha256: string;
  payloadBytes: number;
  rootPath: string;
  schemaVersion: 1;
  status: "committed";
  storage: OpfsStorageEvidence;
  storeId: string;
};

export type OpfsDirectoryRestoreEvidence = {
  directories: number;
  files: number;
  generationId: string;
  manifestSha256: string;
  payloadBytes: number;
  rootPath: string;
  schemaVersion: 1;
  status: "restored";
  storeId: string;
  verification: "manifest-and-every-file-sha256";
};

function validateSegment(value: string, label: string): void {
  if (
    value.length === 0
    || value === "."
    || value === ".."
    || value.includes("/")
    || value.includes("\\")
    || value.includes("\u0000")
  ) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
}

function validateStoreId(value: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value)) {
    throw new Error(`Invalid OPFS directory store ID: ${JSON.stringify(value)}`);
  }
}

function validateAbsolutePath(value: string, label: string): void {
  if (
    value.length === 0
    || value.length > MAX_PATH_LENGTH
    || !value.startsWith("/")
    || value.includes("\\")
    || value.includes("\u0000")
    || (value.length > 1 && value.endsWith("/"))
  ) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  for (const segment of value.slice(1).split("/")) {
    if (segment.length > 0) validateSegment(segment, `${label} segment`);
  }
}

function validateSubtreeRoot(value: string): void {
  validateAbsolutePath(value, "snapshot root path");
  if (value === "/") {
    throw new Error("OPFS directory stores require an explicit subtree root");
  }
}

function relativeChild(parent: string, name: string): string {
  return parent === "/" ? `/${name}` : `${parent}/${name}`;
}

function mountedPath(rootPath: string, relativePath: string): string {
  if (relativePath === "/") return rootPath;
  return rootPath === "/"
    ? relativePath
    : `${rootPath}${relativePath}`;
}

function pathSegments(value: string): string[] {
  validateAbsolutePath(value, "snapshot path");
  return value === "/" ? [] : value.slice(1).split("/");
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function getDirectory(
  parent: FileSystemDirectoryHandle,
  name: string,
  create: boolean
): Promise<FileSystemDirectoryHandle> {
  validateSegment(name, "OPFS directory name");
  return parent.getDirectoryHandle(name, { create });
}

async function getNestedDirectory(
  parent: FileSystemDirectoryHandle,
  names: string[],
  create: boolean
): Promise<FileSystemDirectoryHandle> {
  let current = parent;
  for (const name of names) {
    current = await getDirectory(current, name, create);
  }
  return current;
}

async function writeFile(
  directory: FileSystemDirectoryHandle,
  name: string,
  bytes: Uint8Array
): Promise<void> {
  validateSegment(name, "OPFS filename");
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  try {
    await writable.write(copy);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => undefined);
    throw error;
  }
}

async function readFile(
  directory: FileSystemDirectoryHandle,
  name: string
): Promise<Uint8Array> {
  validateSegment(name, "OPFS filename");
  const handle = await directory.getFileHandle(name);
  const file = await handle.getFile();
  return new Uint8Array(await file.arrayBuffer());
}

async function readJson<T>(
  directory: FileSystemDirectoryHandle,
  name: string
): Promise<T> {
  return JSON.parse(decoder.decode(await readFile(directory, name))) as T;
}

function jsonBytes(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value, null, 2)}\n`);
}

async function storageEvidence(): Promise<OpfsStorageEvidence> {
  const persistedBefore = await navigator.storage.persisted();
  const persistRequestSupported =
    typeof navigator.storage.persist === "function";
  let persistRequestGranted = false;
  let persistRequestError: string | undefined;
  if (persistRequestSupported) {
    try {
      persistRequestGranted = await navigator.storage.persist();
    } catch (error) {
      persistRequestError = error instanceof Error
        ? error.message
        : String(error);
    }
  }
  const persistedAfter = await navigator.storage.persisted();
  return {
    root: "origin-private-file-system",
    persistedBefore,
    persistRequestSupported,
    persistRequestGranted,
    persistedAfter,
    ...(persistRequestError ? { persistRequestError } : {})
  };
}

async function storeRoot(
  storeId: string,
  create: boolean
): Promise<FileSystemDirectoryHandle> {
  validateStoreId(storeId);
  const root = await navigator.storage.getDirectory();
  return getNestedDirectory(
    root,
    [STORE_ROOT, STORES_DIRECTORY, storeId],
    create
  );
}

async function createWasmerDirectory(
  directory: Directory,
  absolutePath: string
): Promise<void> {
  const segments = pathSegments(absolutePath);
  let parent = "/";
  for (const segment of segments) {
    const current = parent === "/" ? `/${segment}` : `${parent}/${segment}`;
    try {
      await directory.createDir(current);
    } catch (error) {
      const entries = await directory.readDir(parent);
      if (
        !entries.some(
          (entry) => entry.name === segment && entry.type === "dir"
        )
      ) {
        throw error;
      }
    }
    parent = current;
  }
}

function validateManifest(
  value: SnapshotManifest,
  expected: {
    generationId: string;
    rootPath: string;
    storeId: string;
  }
): void {
  if (
    value.schemaVersion !== 1
    || value.generationId !== expected.generationId
    || value.rootPath !== expected.rootPath
    || value.storeId !== expected.storeId
  ) {
    throw new Error("OPFS snapshot manifest identity mismatch");
  }
  validateSubtreeRoot(value.rootPath);
  if (
    !Array.isArray(value.directories)
    || value.directories.length === 0
    || value.directories[0] !== "/"
    || !Array.isArray(value.files)
    || value.files.length > MAX_FILES
  ) {
    throw new Error("Invalid OPFS snapshot manifest shape");
  }
  const directories = new Set<string>();
  for (const path of value.directories) {
    validateAbsolutePath(path, "snapshot directory path");
    if (directories.has(path)) {
      throw new Error(`Duplicate snapshot directory path: ${path}`);
    }
    directories.add(path);
  }
  let payloadBytes = 0;
  const files = new Set<string>();
  for (const file of value.files) {
    validateAbsolutePath(file.path, "snapshot file path");
    if (
      file.path === "/"
      || !Number.isSafeInteger(file.bytes)
      || file.bytes < 0
      || !/^[0-9a-f]{64}$/u.test(file.sha256)
      || files.has(file.path)
    ) {
      throw new Error(`Invalid snapshot file entry: ${JSON.stringify(file)}`);
    }
    const slash = file.path.lastIndexOf("/");
    const parent = slash === 0 ? "/" : file.path.slice(0, slash);
    if (!directories.has(parent)) {
      throw new Error(`Snapshot file parent is missing: ${file.path}`);
    }
    files.add(file.path);
    payloadBytes += file.bytes;
    if (payloadBytes > MAX_PAYLOAD_BYTES) {
      throw new Error("OPFS snapshot exceeds the payload limit");
    }
  }
  if (value.payloadBytes !== payloadBytes) {
    throw new Error("OPFS snapshot payload byte count mismatch");
  }
}

export async function commitDirectoryTreeToOpfs(options: {
  directory: Directory;
  rootPath: string;
  storeId: string;
}): Promise<OpfsDirectorySnapshotEvidence> {
  validateSubtreeRoot(options.rootPath);
  validateStoreId(options.storeId);
  const storage = await storageEvidence();
  const generationId = crypto.randomUUID();
  const root = await storeRoot(options.storeId, true);
  const generations = await getDirectory(
    root,
    GENERATIONS_DIRECTORY,
    true
  );
  const generation = await getDirectory(generations, generationId, true);
  const payload = await getDirectory(generation, PAYLOAD_DIRECTORY, true);
  const directories = ["/"];
  const files: SnapshotFile[] = [];
  let payloadBytes = 0;

  const visit = async (
    sourcePath: string,
    relativePath: string,
    destination: FileSystemDirectoryHandle
  ): Promise<void> => {
    const entries = [...await options.directory.readDir(sourcePath)]
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      validateSegment(entry.name, "Wasmer directory entry");
      const childRelativePath = relativeChild(relativePath, entry.name);
      const childSourcePath = sourcePath === "/"
        ? `/${entry.name}`
        : `${sourcePath}/${entry.name}`;
      if (entry.type === "dir") {
        if (directories.length + files.length >= MAX_FILES) {
          throw new Error("OPFS snapshot entry count exceeds the limit");
        }
        directories.push(childRelativePath);
        const childDestination = await getDirectory(
          destination,
          entry.name,
          true
        );
        await visit(
          childSourcePath,
          childRelativePath,
          childDestination
        );
      } else if (entry.type === "file") {
        if (files.length >= MAX_FILES) {
          throw new Error("OPFS snapshot file count exceeds the limit");
        }
        const sourceBytes = await options.directory.readFile(childSourcePath);
        const bytes = new Uint8Array(sourceBytes.byteLength);
        bytes.set(sourceBytes);
        payloadBytes += bytes.byteLength;
        if (payloadBytes > MAX_PAYLOAD_BYTES) {
          throw new Error("OPFS snapshot exceeds the payload limit");
        }
        await writeFile(destination, entry.name, bytes);
        files.push({
          bytes: bytes.byteLength,
          path: childRelativePath,
          sha256: await sha256(bytes)
        });
      } else {
        throw new Error(
          `Unsupported Wasmer directory entry type at ${childSourcePath}`
        );
      }
    }
  };
  await visit(options.rootPath, "/", payload);

  const manifest: SnapshotManifest = {
    schemaVersion: 1,
    storeId: options.storeId,
    generationId,
    rootPath: options.rootPath,
    createdAt: new Date().toISOString(),
    directories,
    files,
    payloadBytes
  };
  validateManifest(manifest, {
    generationId,
    rootPath: options.rootPath,
    storeId: options.storeId
  });
  const manifestBytes = jsonBytes(manifest);
  const manifestSha256 = await sha256(manifestBytes);
  await writeFile(generation, MANIFEST_FILENAME, manifestBytes);

  const head: SnapshotHead = {
    schemaVersion: 1,
    generationId,
    manifestSha256
  };
  // HEAD is the commit point. A partially written generation is never read.
  await writeFile(root, HEAD_FILENAME, jsonBytes(head));
  return {
    schemaVersion: 1,
    status: "committed",
    storeId: options.storeId,
    generationId,
    rootPath: options.rootPath,
    directories: directories.length,
    files: files.length,
    payloadBytes,
    manifestSha256,
    storage
  };
}

export async function restoreDirectoryTreeFromOpfs(options: {
  directory: Directory;
  rootPath: string;
  storeId: string;
}): Promise<OpfsDirectoryRestoreEvidence> {
  validateSubtreeRoot(options.rootPath);
  validateStoreId(options.storeId);
  const root = await storeRoot(options.storeId, false);
  const head = await readJson<SnapshotHead>(root, HEAD_FILENAME);
  if (
    head.schemaVersion !== 1
    || !/^[0-9a-f-]{36}$/u.test(head.generationId)
    || !/^[0-9a-f]{64}$/u.test(head.manifestSha256)
  ) {
    throw new Error("Invalid OPFS snapshot HEAD");
  }
  const generation = await getNestedDirectory(
    root,
    [GENERATIONS_DIRECTORY, head.generationId],
    false
  );
  const manifestBytes = await readFile(generation, MANIFEST_FILENAME);
  if (await sha256(manifestBytes) !== head.manifestSha256) {
    throw new Error("OPFS snapshot manifest hash mismatch");
  }
  const manifest = JSON.parse(
    decoder.decode(manifestBytes)
  ) as SnapshotManifest;
  validateManifest(manifest, {
    generationId: head.generationId,
    rootPath: options.rootPath,
    storeId: options.storeId
  });
  const payload = await getDirectory(
    generation,
    PAYLOAD_DIRECTORY,
    false
  );

  for (const relativePath of [...manifest.directories].sort(
    (left, right) => (
      pathSegments(left).length - pathSegments(right).length
      || left.localeCompare(right)
    )
  )) {
    await createWasmerDirectory(
      options.directory,
      mountedPath(manifest.rootPath, relativePath)
    );
  }

  let payloadBytes = 0;
  for (const file of manifest.files) {
    const segments = pathSegments(file.path);
    const filename = segments.at(-1);
    if (!filename) throw new Error(`Invalid snapshot file path: ${file.path}`);
    const sourceDirectory = await getNestedDirectory(
      payload,
      segments.slice(0, -1),
      false
    );
    const bytes = await readFile(sourceDirectory, filename);
    if (
      bytes.byteLength !== file.bytes
      || await sha256(bytes) !== file.sha256
    ) {
      throw new Error(`OPFS snapshot file verification failed: ${file.path}`);
    }
    await options.directory.writeFile(
      mountedPath(manifest.rootPath, file.path),
      bytes
    );
    payloadBytes += bytes.byteLength;
  }
  if (payloadBytes !== manifest.payloadBytes) {
    throw new Error("Restored OPFS payload byte count mismatch");
  }
  return {
    schemaVersion: 1,
    status: "restored",
    storeId: options.storeId,
    generationId: head.generationId,
    rootPath: manifest.rootPath,
    directories: manifest.directories.length,
    files: manifest.files.length,
    payloadBytes,
    manifestSha256: head.manifestSha256,
    verification: "manifest-and-every-file-sha256"
  };
}
