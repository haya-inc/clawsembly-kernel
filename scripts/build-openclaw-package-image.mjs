import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactContract = JSON.parse(
  await readFile(path.join(root, "contracts", "openclaw-artifact.json"), "utf8")
);
const packageContract = JSON.parse(
  await readFile(
    path.join(root, "contracts", "openclaw-package.generated.json"),
    "utf8"
  )
);
const IMAGE_MAGIC = Buffer.from("CLAWSEMBLYFS1\n", "ascii");
const IMAGE_VERSION = 1;
const IMAGE_FILE_UMASK = 0o022;

function parseArguments(argv) {
  const options = {
    archive:
      process.env.CLAWSEMBLY_OPENCLAW_ARCHIVE === undefined
        ? undefined
        : path.resolve(process.env.CLAWSEMBLY_OPENCLAW_ARCHIVE),
    cache: path.resolve(
      process.env.CLAWSEMBLY_ARTIFACT_CACHE
        ?? path.join(os.tmpdir(), "clawsembly-kernel-artifacts")
    ),
    concurrency: 12,
    evidence: undefined,
    keepTemporary: process.env.CLAWSEMBLY_KEEP_TEMP === "1",
    output: undefined
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--archive" && value) {
      options.archive = path.resolve(value);
      index += 1;
    } else if (argument === "--cache" && value) {
      options.cache = path.resolve(value);
      index += 1;
    } else if (argument === "--concurrency" && value) {
      options.concurrency = Number.parseInt(value, 10);
      index += 1;
    } else if (argument === "--evidence" && value) {
      options.evidence = path.resolve(value);
      index += 1;
    } else if (argument === "--keep-temporary") {
      options.keepTemporary = true;
    } else if (argument === "--output" && value) {
      options.output = path.resolve(value);
      index += 1;
    } else {
      throw new Error(`unknown or incomplete argument: ${argument}`);
    }
  }
  if (!options.output) {
    throw new Error("--output is required");
  }
  if (
    !Number.isSafeInteger(options.concurrency)
    || options.concurrency < 1
    || options.concurrency > 64
  ) {
    throw new Error("--concurrency must be an integer from 1 through 64");
  }
  options.evidence ??= `${options.output}.evidence.json`;
  return options;
}

function digestBytes(bytes, algorithm, encoding = "hex") {
  return createHash(algorithm).update(bytes).digest(encoding);
}

function sriCandidates(integrity) {
  const priority = new Map([
    ["sha512", 3],
    ["sha384", 2],
    ["sha256", 1]
  ]);
  return integrity
    .trim()
    .split(/\s+/u)
    .map((token) => {
      const separator = token.indexOf("-");
      if (separator <= 0) throw new Error(`invalid SRI token: ${token}`);
      return {
        algorithm: token.slice(0, separator),
        encoded: token.slice(separator + 1)
      };
    })
    .filter(({ algorithm }) => priority.has(algorithm))
    .sort((left, right) => (
      priority.get(right.algorithm) - priority.get(left.algorithm)
    ));
}

function verifySri(bytes, integrity) {
  const candidates = sriCandidates(integrity);
  if (candidates.length === 0) {
    throw new Error(`no supported digest in SRI value: ${integrity}`);
  }
  return candidates.some(({ algorithm, encoded }) => (
    digestBytes(bytes, algorithm, "base64") === encoded
  ));
}

function cacheNameForIntegrity(integrity) {
  const [{ algorithm, encoded }] = sriCandidates(integrity);
  const hexadecimal = Buffer.from(encoded, "base64").toString("hex");
  return `${algorithm}-${hexadecimal}.tgz`;
}

function runTar(arguments_, label, options = {}) {
  const environment = { ...process.env };
  delete environment.TAR_OPTIONS;
  const result = spawnSync("tar", arguments_, {
    encoding: "utf8",
    env: environment,
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(
      `${label} failed: ${result.stderr || result.stdout}`
    );
  }
  return result.stdout;
}

let tarExtractionCapabilities;

function getTarExtractionCapabilities() {
  if (tarExtractionCapabilities) return tarExtractionCapabilities;
  const result = spawnSync("tar", ["--help"], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.error) throw result.error;
  const help = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  tarExtractionCapabilities = {
    delayDirectoryRestore: help.includes("--delay-directory-restore"),
    noOverwriteDirectory: help.includes("--no-overwrite-dir")
  };
  return tarExtractionCapabilities;
}

async function prepareArchiveDirectories(
  destination,
  archiveEntries,
  stripComponents
) {
  const relativeDirectories = new Set([""]);
  for (const entry of archiveEntries) {
    const components = entry.replace(/\/$/u, "").split("/");
    const stripped = components.slice(stripComponents);
    for (let length = 1; length < stripped.length; length += 1) {
      relativeDirectories.add(stripped.slice(0, length).join("/"));
    }
  }
  const orderedDirectories = [...relativeDirectories].sort(
    (left, right) => (
      left.split("/").length - right.split("/").length
      || left.localeCompare(right)
    )
  );
  for (const relativeDirectory of orderedDirectories) {
    const absoluteDirectory = path.join(
      destination,
      ...relativeDirectory.split("/").filter(Boolean)
    );
    await mkdir(absoluteDirectory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(absoluteDirectory);
    if (!metadata.isDirectory()) {
      throw new Error(
        `archive parent is not a directory: ${relativeDirectory || "."}`
      );
    }
    if ((metadata.mode & 0o700) !== 0o700) {
      await chmod(absoluteDirectory, metadata.mode | 0o700);
    }
  }
}

async function extractNpmArchive(
  archivePath,
  destination,
  archiveEntries,
  label,
  stripComponents = 0
) {
  const capabilities = getTarExtractionCapabilities();
  await prepareArchiveDirectories(
    destination,
    archiveEntries,
    stripComponents
  );
  const arguments_ = [
    "-xzf",
    archivePath,
    "-C",
    destination,
    ...(stripComponents === 0
      ? []
      : [`--strip-components=${stripComponents}`]),
    ...(capabilities.delayDirectoryRestore
      ? ["--delay-directory-restore"]
      : []),
    ...(capabilities.noOverwriteDirectory
      ? ["--no-overwrite-dir"]
      : [])
  ];
  runTar(arguments_, label);
}

function validateNpmArchive(archivePath, label, expectedRoot) {
  const listing = runTar(["-tzf", archivePath], `${label} listing`);
  const entries = listing.split(/\r?\n/u).filter(Boolean);
  if (entries.length === 0) throw new Error(`${label} is empty`);
  let archiveRoot;
  for (const entry of entries) {
    const pathWithoutTrailingSlash = entry.replace(/\/$/u, "");
    const normalized = path.posix.normalize(pathWithoutTrailingSlash);
    const [entryRoot] = pathWithoutTrailingSlash.split("/");
    if (
      !entryRoot
      || entryRoot === "."
      || entryRoot === ".."
      || path.posix.isAbsolute(entry)
      || entry.split("/").includes("..")
      || !(normalized === entryRoot || normalized.startsWith(`${entryRoot}/`))
    ) {
      throw new Error(`${label} contains an unsafe path: ${entry}`);
    }
    archiveRoot ??= entryRoot;
    if (entryRoot !== archiveRoot) {
      throw new Error(
        `${label} has more than one top-level directory: `
        + `${archiveRoot}, ${entryRoot}`
      );
    }
  }
  if (expectedRoot !== undefined && archiveRoot !== expectedRoot) {
    throw new Error(
      `${label} has unexpected top-level directory: ${archiveRoot}`
    );
  }
  return { entries: entries.length, paths: entries, root: archiveRoot };
}

async function readVerifiedFile(filename, integrity) {
  let bytes;
  try {
    bytes = await readFile(filename);
  } catch {
    return undefined;
  }
  if (!verifySri(bytes, integrity)) return undefined;
  return bytes;
}

async function fetchVerifiedArtifact(options) {
  if (options.override) {
    const bytes = await readFile(options.override);
    if (!verifySri(bytes, options.integrity)) {
      throw new Error(`artifact override failed integrity verification: ${options.override}`);
    }
    return { bytes, path: options.override };
  }

  const cachePath = path.join(
    options.cache,
    "openclaw-packages",
    cacheNameForIntegrity(options.integrity)
  );
  const cachedBytes = await readVerifiedFile(cachePath, options.integrity);
  if (cachedBytes) return { bytes: cachedBytes, path: cachePath };

  await mkdir(path.dirname(cachePath), { recursive: true });
  await unlink(cachePath).catch(() => {});
  const response = await fetch(options.url);
  if (!response.ok) {
    throw new Error(`download failed (${response.status}): ${options.url}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!verifySri(bytes, options.integrity)) {
    throw new Error(`downloaded artifact failed integrity verification: ${options.url}`);
  }
  const temporaryPath = `${cachePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, bytes, { mode: 0o600 });
  await rename(temporaryPath, cachePath);
  return { bytes, path: cachePath };
}

async function mapConcurrent(values, concurrency, callback) {
  const results = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      results[index] = await callback(values[index], index);
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, values.length) },
      () => worker()
    )
  );
  return results;
}

function hashJson(bytes) {
  return digestBytes(bytes, "sha256");
}

async function verifyExtractedRoot(packageRoot) {
  const packageJsonBytes = await readFile(
    path.join(packageRoot, "package.json")
  );
  const shrinkwrapBytes = await readFile(
    path.join(packageRoot, "npm-shrinkwrap.json")
  );
  const launcherBytes = await readFile(
    path.join(packageRoot, packageContract.artifactFiles.launcher.path)
  );
  const entryBytes = await readFile(
    path.join(packageRoot, packageContract.artifactFiles.entry.path)
  );
  if (hashJson(packageJsonBytes) !== packageContract.packageJsonSha256) {
    throw new Error("extracted package.json does not match the package contract");
  }
  if (hashJson(shrinkwrapBytes) !== packageContract.shrinkwrap.sha256) {
    throw new Error("extracted npm-shrinkwrap.json does not match the package contract");
  }
  if (
    launcherBytes.byteLength !== packageContract.artifactFiles.launcher.bytes
    || hashJson(launcherBytes)
      !== packageContract.artifactFiles.launcher.sha256
  ) {
    throw new Error("extracted openclaw.mjs does not match the package contract");
  }
  if (
    entryBytes.byteLength !== packageContract.artifactFiles.entry.bytes
    || hashJson(entryBytes) !== packageContract.artifactFiles.entry.sha256
  ) {
    throw new Error("extracted dist/entry.js does not match the package contract");
  }
  const metadata = JSON.parse(packageJsonBytes.toString("utf8"));
  if (
    metadata.name !== artifactContract.name
    || metadata.version !== artifactContract.version
  ) {
    throw new Error("extracted package metadata does not match the artifact contract");
  }
  return metadata;
}

async function verifyDependencyManifest(packageRoot, dependency) {
  const manifestPath = path.join(
    packageRoot,
    ...dependency.installPath.split("/"),
    "package.json"
  );
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.version !== dependency.version) {
    throw new Error(
      `${dependency.installPath} version mismatch: `
      + `${manifest.version} !== ${dependency.version}`
    );
  }
  const lifecycleScripts = Object.fromEntries(
    ["preinstall", "install", "postinstall"]
      .filter((name) => typeof manifest.scripts?.[name] === "string")
      .map((name) => [name, manifest.scripts[name]])
  );
  if (
    dependency.hasInstallScript === true
    && Object.keys(lifecycleScripts).length === 0
  ) {
    throw new Error(
      `${dependency.installPath} was marked hasInstallScript without a lifecycle script`
    );
  }
  if (
    dependency.hasInstallScript !== true
    && Object.keys(lifecycleScripts).length > 0
  ) {
    throw new Error(
      `${dependency.installPath} has an untracked lifecycle script`
    );
  }
  return {
    installPath: dependency.installPath,
    name: manifest.name,
    version: manifest.version,
    manifestSha256: hashJson(manifestBytes),
    ...(Object.keys(lifecycleScripts).length === 0
      ? {}
      : { lifecycleScripts })
  };
}

async function normalizeDirectoryPermissions(directory) {
  let changed = 0;

  async function visit(current) {
    const metadata = await lstat(current);
    if (!metadata.isDirectory()) return;
    if ((metadata.mode & 0o700) !== 0o700) {
      await chmod(current, metadata.mode | 0o700);
      changed += 1;
    }
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await visit(path.join(current, entry.name));
      }
    }
  }

  await visit(directory);
  return changed;
}

async function collectFiles(directory) {
  const rootRealPath = await realpath(directory);
  const files = [];
  let materializedSymlinks = 0;
  let normalizedFileModes = 0;

  function imageFileMode(metadata) {
    const archiveMode = metadata.mode & 0o777;
    const normalizedMode = archiveMode & ~IMAGE_FILE_UMASK;
    if (archiveMode !== normalizedMode) normalizedFileModes += 1;
    return normalizedMode;
  }

  async function visit(current, relativeDirectory) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => (
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    ));
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        const metadata = await stat(absolutePath);
        files.push({
          absolutePath,
          relativePath,
          mode: imageFileMode(metadata)
        });
      } else if (entry.isSymbolicLink()) {
        const target = await readlink(absolutePath);
        const resolved = await realpath(path.resolve(current, target));
        if (
          resolved !== rootRealPath
          && !resolved.startsWith(`${rootRealPath}${path.sep}`)
        ) {
          throw new Error(`symlink escapes package image root: ${relativePath}`);
        }
        const metadata = await lstat(resolved);
        if (!metadata.isFile()) {
          throw new Error(`non-file symlink is unsupported: ${relativePath}`);
        }
        files.push({
          absolutePath: resolved,
          relativePath,
          mode: imageFileMode(metadata)
        });
        materializedSymlinks += 1;
      } else {
        throw new Error(`unsupported filesystem entry: ${relativePath}`);
      }
    }
  }

  await visit(directory, "");
  files.sort((left, right) => (
    left.relativePath < right.relativePath
      ? -1
      : left.relativePath > right.relativePath
        ? 1
        : 0
  ));
  return { files, materializedSymlinks, normalizedFileModes };
}

function writeWithBackpressure(stream, bytes) {
  if (stream.write(bytes)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      stream.off("drain", onDrain);
      stream.off("error", onError);
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}

async function writeImage(outputPath, files) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  const stream = createWriteStream(temporaryPath, { mode: 0o600 });
  const hash = createHash("sha256");
  let imageBytes = 0;
  let payloadBytes = 0;

  async function write(bytes) {
    hash.update(bytes);
    imageBytes += bytes.byteLength;
    await writeWithBackpressure(stream, bytes);
  }

  try {
    const preamble = Buffer.alloc(IMAGE_MAGIC.byteLength + 8);
    IMAGE_MAGIC.copy(preamble, 0);
    preamble.writeUInt32BE(IMAGE_VERSION, IMAGE_MAGIC.byteLength);
    preamble.writeUInt32BE(files.length, IMAGE_MAGIC.byteLength + 4);
    await write(preamble);

    for (const file of files) {
      const pathBytes = Buffer.from(`/${file.relativePath}`, "utf8");
      const metadata = await stat(file.absolutePath);
      const header = Buffer.alloc(16);
      header.writeUInt32BE(pathBytes.byteLength, 0);
      header.writeUInt32BE(file.mode, 4);
      header.writeBigUInt64BE(BigInt(metadata.size), 8);
      await write(header);
      await write(pathBytes);
      const input = createReadStream(file.absolutePath);
      for await (const chunk of input) {
        payloadBytes += chunk.byteLength;
        await write(chunk);
      }
    }
    await new Promise((resolve, reject) => {
      stream.once("error", reject);
      stream.end(resolve);
    });
    await rename(temporaryPath, outputPath);
    await chmod(outputPath, 0o600);
    return {
      format: "clawsemblyfs",
      version: IMAGE_VERSION,
      sha256: hash.digest("hex"),
      bytes: imageBytes,
      payloadBytes,
      files: files.length
    };
  } catch (error) {
    stream.destroy();
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "clawsembly-openclaw-package-image-")
  );
  let retainTemporary = options.keepTemporary;
  try {
    const official = await fetchVerifiedArtifact({
      cache: options.cache,
      integrity: artifactContract.integrity,
      override: options.archive,
      url: artifactContract.tarball
    });
    const officialArchive = validateNpmArchive(
      official.path,
      "official OpenClaw archive",
      "package"
    );

    await extractNpmArchive(
      official.path,
      temporaryRoot,
      officialArchive.paths,
      "official OpenClaw extraction"
    );
    const packageRoot = path.join(temporaryRoot, "package");
    let normalizedDirectoryModes =
      await normalizeDirectoryPermissions(packageRoot);
    const rootManifest = await verifyExtractedRoot(packageRoot);

    process.stdout.write(
      `Fetching ${packageContract.dependencies.length} integrity-pinned `
      + `runtime archives with concurrency ${options.concurrency}...\n`
    );
    const uniqueDependencies = [
      ...new Map(
        packageContract.dependencies.map((dependency) => [
          dependency.integrity,
          dependency
        ])
      ).values()
    ];
    const uniqueArchives = await mapConcurrent(
      uniqueDependencies,
      options.concurrency,
      async (dependency) => ({
        dependency,
        artifact: await fetchVerifiedArtifact({
          cache: options.cache,
          integrity: dependency.integrity,
          url: dependency.resolved
        })
      })
    );
    const archiveByIntegrity = new Map(
      uniqueArchives.map(({ artifact, dependency }) => [
        dependency.integrity,
        artifact
      ])
    );
    const dependencyArchives = packageContract.dependencies.map(
      (dependency) => ({
        dependency,
        artifact: archiveByIntegrity.get(dependency.integrity)
      })
    );

    process.stdout.write("Extracting and verifying the locked runtime graph...\n");
    const dependencyManifests = [];
    for (const { artifact, dependency } of dependencyArchives) {
      const archive = validateNpmArchive(
        artifact.path,
        dependency.installPath
      );
      const destination = path.join(
        packageRoot,
        ...dependency.installPath.split("/")
      );
      await mkdir(destination, { recursive: true });
      await extractNpmArchive(
        artifact.path,
        destination,
        archive.paths,
        `${dependency.installPath} extraction`,
        1
      );
      normalizedDirectoryModes +=
        await normalizeDirectoryPermissions(destination);
      dependencyManifests.push(
        await verifyDependencyManifest(packageRoot, dependency)
      );
    }

    const rootLifecycleScripts = Object.fromEntries(
      ["preinstall", "install", "postinstall"]
        .filter((name) => typeof rootManifest.scripts?.[name] === "string")
        .map((name) => [name, rootManifest.scripts[name]])
    );
    const actualLifecycleEntries = [
      ...(Object.keys(rootLifecycleScripts).length === 0
        ? []
        : [{
            installPath: "",
            name: rootManifest.name,
            version: rootManifest.version,
            lifecycleScripts: rootLifecycleScripts
          }]),
      ...dependencyManifests.filter((entry) => entry.lifecycleScripts)
    ];
    const expectedLifecyclePaths =
      packageContract.shrinkwrap.lifecycleEntries.map((entry) => entry.installPath);
    const actualLifecyclePaths =
      actualLifecycleEntries.map((entry) => entry.installPath);
    if (
      JSON.stringify(actualLifecyclePaths)
      !== JSON.stringify(expectedLifecyclePaths)
    ) {
      throw new Error(
        "extracted lifecycle-script entries do not match the package contract"
      );
    }

    const {
      files,
      materializedSymlinks,
      normalizedFileModes
    } = await collectFiles(packageRoot);
    process.stdout.write(
      `Writing ${files.length} files to ${options.output}...\n`
    );
    const image = await writeImage(options.output, files);
    const evidence = {
      schemaVersion: 1,
      claim:
        "The exact official OpenClaw package and every runtime archive in its "
        + "published npm shrinkwrap were integrity-verified and assembled into "
        + "a browser-mountable filesystem image without modifying package files.",
      artifact: packageContract.artifact,
      packageContract: {
        packageJsonSha256: packageContract.packageJsonSha256,
        shrinkwrapSha256: packageContract.shrinkwrap.sha256,
        artifactFiles: packageContract.artifactFiles,
        dependencyArchives: packageContract.dependencies.length
      },
      assembly: {
        method: "direct integrity-pinned npm archive extraction",
        delayedDirectoryMetadataRestore:
          getTarExtractionCapabilities().delayDirectoryRestore,
        preservedPreparedDirectoryPermissions:
          getTarExtractionCapabilities().noOverwriteDirectory,
        dependencyManifests: dependencyManifests.length,
        optionalArchives:
          packageContract.dependencies.filter((entry) => entry.optional).length,
        imageFileUmask: "0022",
        materializedSymlinks,
        normalizedFileModes,
        normalizedDirectoryModes,
        lifecycleScripts: {
          executed: false,
          entries: actualLifecycleEntries
        }
      },
      image,
      remainingGates: {
        lifecycleScripts:
          "The four declared lifecycle-script entries are recorded. Required "
          + "effects are intentionally deferred to the capability-scoped "
          + "browser install proof.",
        nodeCompatibility:
          "The image does not claim Node 24.15 compatibility or bypass the "
          + "official launcher version gate.",
        sqliteCapability:
          "The browser Edge.js process does not yet expose the proven OPFS "
          + "node:sqlite personality.",
        completeEntrypoint:
          "The complete unmodified dist/entry.js path has not yet executed."
      }
    };
    await mkdir(path.dirname(options.evidence), { recursive: true });
    await writeFile(
      options.evidence,
      `${JSON.stringify(evidence, null, 2)}\n`,
      { mode: 0o600 }
    );
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } catch (error) {
    retainTemporary = true;
    process.stderr.write(`Package image workspace retained at ${temporaryRoot}\n`);
    throw error;
  } finally {
    if (!retainTemporary) {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}

await main();
