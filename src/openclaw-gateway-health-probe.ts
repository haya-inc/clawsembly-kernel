import "./style.css";
import { parseClawsemblyFs } from "./clawsemblyfs";
import {
  inspectOpenClawInstallState,
  runOpenClawInstallLifecycle
} from "./openclaw-install-lifecycle";
import { isCompletedAgentTurnResponse } from
  "./openclaw-agent-turn-response";
import { restoreDirectoryTreeFromOpfs } from "./opfs-directory-store";

type OpenClawPackage = {
  engines?: {
    node?: string;
  };
  name?: string;
  version?: string;
};

type WasixOutput = {
  code: number;
  ok: boolean;
  stderr: string;
  stdout: string;
};

type HealthResponse = {
  ok: true;
  plugins: {
    errors: unknown[];
    loaded: unknown[];
  };
};

type LiveProviderCapability = {
  brokerToken?: string;
  providerApiKey?: string;
  relayToken: string;
};

type StreamCapture = {
  cancel: () => Promise<void>;
  done: Promise<void>;
  snapshot: () => string;
  waitFor: (marker: string, timeoutMs: number) => Promise<void>;
  waitUntil: (
    predicate: (captured: string) => boolean,
    description: string,
    timeoutMs: number
  ) => Promise<void>;
};

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

async function fetchBytes(
  url: string,
  label: string
): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${label} fetch failed with ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function captureStream(
  stream: ReadableStream<Uint8Array>
): StreamCapture {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const waiters = new Set<() => void>();
  let captured = "";
  let failure: unknown;
  let finished = false;
  const notify = () => {
    for (const waiter of [...waiters]) waiter();
  };
  const done = (async () => {
    try {
      for (;;) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        captured += decoder.decode(value, { stream: true });
        notify();
      }
      captured += decoder.decode();
    } catch (error) {
      failure = error;
    } finally {
      finished = true;
      notify();
      reader.releaseLock();
    }
  })();
  return {
    cancel: async () => {
      try {
        await reader.cancel();
      } catch {
        // The page teardown or process exit may close the pipe first.
      }
    },
    done,
    snapshot: () => captured,
    waitFor: (expectedMarker, timeoutMs) => {
      if (captured.includes(expectedMarker)) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          cleanup();
          reject(
            new Error(
              `Timed out waiting for stream marker: ${expectedMarker}`
            )
          );
        }, timeoutMs);
        const check = () => {
          if (captured.includes(expectedMarker)) {
            cleanup();
            resolve();
          } else if (finished) {
            cleanup();
            reject(
              failure
                ?? new Error(
                  `Stream ended before marker: ${expectedMarker}`
                )
            );
          }
        };
        const cleanup = () => {
          window.clearTimeout(timeout);
          waiters.delete(check);
        };
        waiters.add(check);
      });
    },
    waitUntil: (predicate, description, timeoutMs) => {
      if (predicate(captured)) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          cleanup();
          reject(
            new Error(`Timed out waiting for ${description}`)
          );
        }, timeoutMs);
        const check = () => {
          if (predicate(captured)) {
            cleanup();
            resolve();
          } else if (finished) {
            cleanup();
            reject(
              failure
                ?? new Error(`Stream ended before ${description}`)
            );
          }
        };
        const cleanup = () => {
          window.clearTimeout(timeout);
          waiters.delete(check);
        };
        waiters.add(check);
      });
    }
  };
}

function parseJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("Gateway health client emitted no JSON");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) {
      throw new Error("Gateway health client emitted invalid JSON");
    }
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

function serializableOutput(output: WasixOutput): WasixOutput {
  return {
    code: output.code,
    ok: output.ok,
    stdout: output.stdout,
    stderr: output.stderr
  };
}

function isHealthyResponse(value: unknown): value is HealthResponse {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) {
    return false;
  }
  const candidate = value as {
    ok?: unknown;
    plugins?: {
      errors?: unknown;
      loaded?: unknown;
    };
  };
  return candidate.ok === true
    && Array.isArray(candidate.plugins?.loaded)
    && Array.isArray(candidate.plugins?.errors)
    && candidate.plugins.errors.length === 0;
}

function consumeLiveProviderCapability(): LiveProviderCapability | undefined {
  const capabilityKey = "__CLAWSEMBLY_LIVE_PROVIDER_CAPABILITY__";
  const capabilityGlobal =
    globalThis as unknown as Record<string, unknown>;
  const value = capabilityGlobal[capabilityKey];
  delete capabilityGlobal[capabilityKey];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as {
    brokerToken?: unknown;
    providerApiKey?: unknown;
    relayToken?: unknown;
  };
  if (
    typeof candidate.relayToken !== "string"
    || candidate.relayToken.length === 0
    || candidate.relayToken.length > 128
  ) {
    return undefined;
  }
  const providerApiKey =
    typeof candidate.providerApiKey === "string"
      && candidate.providerApiKey.length > 0
      && candidate.providerApiKey.length <= 4_096
      ? candidate.providerApiKey
      : undefined;
  const brokerToken =
    typeof candidate.brokerToken === "string"
      && candidate.brokerToken.length > 0
      && candidate.brokerToken.length <= 128
      ? candidate.brokerToken
      : undefined;
  if (!providerApiKey && !brokerToken) return undefined;
  return {
    ...(brokerToken ? { brokerToken } : {}),
    ...(providerApiKey ? { providerApiKey } : {}),
    relayToken: candidate.relayToken
  };
}

function redactSensitiveValues<T>(value: T, sensitive: string[]): T {
  if (typeof value === "string") {
    return sensitive.reduce(
      (redacted, secret) => redacted.replaceAll(secret, "[REDACTED]"),
      value
    ) as T;
  }
  if (Array.isArray(value)) {
    return value.map(
      (entry) => redactSensitiveValues(entry, sensitive)
    ) as T;
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactSensitiveValues(entry, sensitive)
      ])
    ) as T;
  }
  return value;
}

const status = requiredElement<HTMLOutputElement>("#status");
const result = requiredElement<HTMLPreElement>("#result");
const searchParams = new URLSearchParams(location.search);
const artifactUrl = searchParams.get("artifact") ?? "/edgejs.wasm";
const imageUrl = searchParams.get("image") ?? "/openclaw.clawfs";
const requestedProofKind = searchParams.get("proof");
const proofKind = requestedProofKind === "agent-turn"
  || requestedProofKind === "live-agent-turn"
  || requestedProofKind === "brokered-live-agent-turn"
  ? requestedProofKind
  : "health";
const agentTurnProof = proofKind !== "health";
const directLiveProviderProof = proofKind === "live-agent-turn";
const brokeredLiveProviderProof =
  proofKind === "brokered-live-agent-turn";
const liveProviderProof =
  directLiveProviderProof || brokeredLiveProviderProof;
const liveProviderCapability = liveProviderProof
  ? consumeLiveProviderCapability()
  : undefined;
const relayUrl =
  searchParams.get("relay") ?? "ws://127.0.0.1:18792/v1/network";
const relayToken = liveProviderProof
  ? liveProviderCapability?.relayToken
  : searchParams.get("token");
const restoreStore = searchParams.get("restoreStore");
const diagnosticErrorDetail = searchParams.get("errorDetail") === "1";
const requestedProofTimeoutMs = Number(searchParams.get("timeoutMs"));
const proofTimeoutMs =
  Number.isSafeInteger(requestedProofTimeoutMs)
    && requestedProofTimeoutMs >= 60_000
    && requestedProofTimeoutMs <= 300_000
    ? requestedProofTimeoutMs
    : 240_000;
const gatewayPort = 18_789;
const gatewayUrl = `ws://127.0.0.1:${gatewayPort}`;
const gatewayToken = "clawsembly-diagnostic-non-secret-token";
const providerHost = directLiveProviderProof
  ? "models.github.ai"
  : "localhost";
const providerPort = directLiveProviderProof ? 443 : 18_794;
const providerModel = liveProviderProof
  ? "openai/gpt-4o"
  : "clawsembly-proof";
const providerName = directLiveProviderProof
  ? "github-models"
  : brokeredLiveProviderProof
    ? "clawsembly-broker"
    : "clawsembly";
const providerBaseUrl = directLiveProviderProof
  ? "https://models.github.ai/inference"
  : `http://localhost:${providerPort}/v1`;
const providerApiKey = directLiveProviderProof
  ? liveProviderCapability?.providerApiKey
  : brokeredLiveProviderProof
    ? liveProviderCapability?.brokerToken
    : "clawsembly-fixture-key";
const providerDisplayName = directLiveProviderProof
  ? "GitHub Models live TLS proof"
  : brokeredLiveProviderProof
    ? "Clawsembly opaque credential-broker proof"
    : "Clawsembly deterministic proof fixture";
const sensitiveValues = liveProviderProof
  ? [
      relayToken,
      liveProviderCapability?.brokerToken,
      liveProviderCapability?.providerApiKey
    ].filter(
      (value): value is string => typeof value === "string" && value.length > 0
    )
  : [];
const agentTurnMarker = "CLAWSEMBLY_AGENT_TURN_OK";
const agentTurnTimeoutSeconds = 120;
const readinessMarker = "http server listening";
const clientLaunchMarker = "agent runtime plugins pre-warmed";
const clientCompletionGraceMs = 10_000;

async function runProbe(): Promise<void> {
  try {
    if (!crossOriginIsolated) {
      throw new Error(
        "OpenClaw Gateway WASIX requires a cross-origin-isolated context"
      );
    }
    const { Directory, init, Runtime, runWasix } =
      await import("@wasmer/sdk");
    await init();
    if (agentTurnProof && !relayToken) {
      throw new Error("The agent-turn relay capability token is required");
    }
    if (
      brokeredLiveProviderProof
      && liveProviderCapability?.providerApiKey
    ) {
      throw new Error(
        "The brokered proof rejects provider credentials at the browser boundary"
      );
    }
    if (liveProviderProof && !providerApiKey) {
      throw new Error(
        brokeredLiveProviderProof
          ? "The opaque provider-broker capability is required"
          : "The live provider capability is required"
      );
    }
    const runtimeOptions = agentTurnProof
      ? {
          registry: null,
          networkEgress: {
            gatewayUrl: relayUrl,
            gatewayToken: relayToken!,
            allow: [{
              host: providerHost,
              port: providerPort,
              allowPrivateNetwork: !directLiveProviderProof
            }]
          }
        }
      : { registry: null };
    const wasixRuntime = new Runtime(
      runtimeOptions as ConstructorParameters<typeof Runtime>[0]
    );

    status.textContent = "Fetching Edge.js and the official package image…";
    const [edgeBytes, imageBytes] = await Promise.all([
      fetchBytes(artifactUrl, "Edge.js WASIX"),
      fetchBytes(imageUrl, "OpenClaw package image")
    ]);
    if (!WebAssembly.validate(edgeBytes)) {
      throw new Error("Chromium rejected the Edge.js WASIX module");
    }

    status.textContent = "Verifying the complete package graph…";
    const parsed = parseClawsemblyFs(imageBytes);
    const packageBytes = parsed.files["/package.json"];
    const launcherBytes = parsed.files["/openclaw.mjs"];
    const entryBytes = parsed.files["/dist/entry.js"];
    if (!packageBytes || !launcherBytes || !entryBytes) {
      throw new Error("package image is missing an official entrypoint file");
    }
    const packageMetadata = JSON.parse(
      new TextDecoder().decode(packageBytes)
    ) as OpenClawPackage;
    if (
      packageMetadata.name !== "openclaw"
      || !packageMetadata.version
      || !packageMetadata.engines?.node
    ) {
      throw new Error("package image does not contain valid OpenClaw metadata");
    }
    const [
      artifactSha256,
      imageSha256,
      packageJsonSha256,
      launcherSha256,
      entrySha256
    ] = await Promise.all([
      sha256(edgeBytes),
      sha256(imageBytes),
      sha256(packageBytes),
      sha256(launcherBytes),
      sha256(entryBytes)
    ]);
    const artifactEvidence = {
      bytes: edgeBytes.byteLength,
      sha256: artifactSha256
    };
    const imageEvidence = {
      bytes: imageBytes.byteLength,
      files: parsed.fileCount,
      payloadBytes: parsed.payloadBytes,
      sha256: imageSha256,
      version: parsed.version
    };
    const openclawEvidence = {
      name: packageMetadata.name,
      version: packageMetadata.version,
      nodeEngine: packageMetadata.engines.node,
      packageJsonSha256,
      launcherSha256,
      entrySha256
    };
    let packageFiles = parsed.files;
    let diagnosticMutation:
      | {
          path: string;
          purpose: string;
        }
      | undefined;
    if (diagnosticErrorDetail) {
      packageFiles = { ...parsed.files };
      const needle = [
        "`causeCode=${read(cause?.code)}`,",
        "`message=${error instanceof Error ? error.message : read(record.message)}`"
      ].join("\n\t\t\t");
      const replacement = [
        "`causeCode=${read(cause?.code)}`,",
        "`causeMessage=${read(cause?.message)}`,",
        "`causeStack=${read(cause?.stack)}`,",
        "`message=${error instanceof Error ? error.message : read(record.message)}`"
      ].join("\n\t\t\t");
      for (const [filePath, fileBytes] of Object.entries(packageFiles)) {
        if (!filePath.startsWith("/dist/stream-")) continue;
        const source = new TextDecoder().decode(fileBytes);
        if (!source.includes(needle)) continue;
        packageFiles[filePath] = new TextEncoder().encode(
          source.replace(needle, replacement)
        );
        diagnosticMutation = {
          path: filePath,
          purpose:
            "Expose the nested model-fetch cause message and stack in logs"
        };
        break;
      }
      if (!diagnosticMutation) {
        throw new Error("Could not install the error-detail diagnostic");
      }
    }
    const networkEvidence = {
      namespace: agentTurnProof
        ? directLiveProviderProof
          ? "browser-local-loopback+live-tls-capability-egress"
          : brokeredLiveProviderProof
            ? "browser-local-loopback+credential-broker-capability-egress"
          : "browser-local-loopback+capability-egress"
        : "browser-local-loopback",
      url: gatewayUrl,
      externalEgress: agentTurnProof
        ? {
            allow: [{
              host: providerHost,
              port: providerPort,
              allowPrivateNetwork: !directLiveProviderProof
            }],
            credentialTransport: "Sec-WebSocket-Protocol",
            ...(directLiveProviderProof
              ? {
                  guestTls: {
                    authority: providerHost,
                    certificateValidation:
                      "Node TLS/SNI validates the provider certificate"
                  }
                }
              : {}),
            relayUrl,
            tokenRecorded: false,
            transport: "self-hosted-virtual-net-websocket-relay"
          }
        : "denied-by-default"
    };
    const isolationEvidence = {
      sharedRuntimeNetworkNamespace: true,
      distinctFilesystemInstances: true,
      clientRetryFilesystem: "one prebuilt filesystem reused sequentially",
      gatewayStateRoot: "/openclaw/.clawsembly-gateway-state",
      clientStateRootPattern: "/openclaw/.clawsembly-client-state-{attempt}"
    };
    const notNorthStarCompletion = directLiveProviderProof
      ? "This proves a live authorized model turn over guest-enforced TLS; "
        + "durable fresh-browser OPFS recovery is proven separately in the "
        + "same public build. A repository-isolated CI job supplies its "
        + "short-lived models:read token and a DNS-derived endpoint grant as "
        + "explicit guest capabilities for this compatibility proof; the "
        + "brokered proof separately closes the provider-secret boundary."
      : brokeredLiveProviderProof
        ? "This proves a live authorized model turn while the provider "
          + "credential remains outside the browser and both WASIX guests. "
          + "The same public build separately binds this result to the raw "
          + "guest-TLS compatibility proof and durable fresh-browser OPFS "
          + "recovery proof."
      : proofKind === "agent-turn"
        ? "This proves the real unmodified OpenClaw agent path against a "
          + "deterministic OpenAI-compatible fixture under the source-declared "
          + "Node compatibility profile, but does not replace live-provider "
          + "TLS or durable fresh-session OPFS recovery proof."
      : "This proves the unmodified Gateway health path under the "
        + "source-declared Node compatibility profile, but does not replace "
        + "the agent-turn, live-provider TLS, or durable fresh-session OPFS "
        + "recovery proofs.";
    const launchHarnessEvidence = {
      officialEntrypoint: "/openclaw/dist/entry.js",
      openclawPackageFilesMutated: diagnosticMutation !== undefined,
      ...(diagnosticMutation ? { diagnosticMutation } : {}),
      clientCompletionGraceMs,
      clientLaunchMarker,
      gateway:
        "Sets guest process.argv, records the runtime compatibility label, "
        + "and retains a bounded watchdog while dynamically importing the "
        + "official entrypoint.",
      client:
        "Sets guest process.argv, retains a bounded watchdog, and exits "
        + "with the official entrypoint's process.exitCode after a bounded "
        + "output-drain grace once its dynamic import settles."
    };

    const maxClientAttempts = agentTurnProof ? 1 : 3;
    const gatewayOpenclaw = new Directory(packageFiles);
    const clientOpenclaw = new Directory(packageFiles);
    const gatewayStateRoot = "/openclaw/.clawsembly-gateway-state";
    const mountedGatewayStateRoot =
      gatewayStateRoot.replace(/^\/openclaw/u, "");
    const gatewayWorkspace = "/openclaw/.clawsembly-gateway-workspace";
    if (!restoreStore) {
      await gatewayOpenclaw.createDir(mountedGatewayStateRoot);
    }
    await gatewayOpenclaw.createDir("/.clawsembly-gateway-workspace");
    const module = await WebAssembly.compile(edgeBytes);
    const moduleWithBytes = {
      module,
      bytes: edgeBytes
    } as unknown as WebAssembly.Module;
    let persistentStateRestore:
      | Awaited<ReturnType<typeof restoreDirectoryTreeFromOpfs>>
      | undefined;
    const installLifecycle = restoreStore
      ? await (async () => {
          status.textContent =
            "Restoring committed OpenClaw state from OPFS…";
          persistentStateRestore = await restoreDirectoryTreeFromOpfs({
            directory: gatewayOpenclaw,
            rootPath: mountedGatewayStateRoot,
            storeId: restoreStore
          });
          const packageStateDatabase = await inspectOpenClawInstallState({
            directory: gatewayOpenclaw,
            homeDir: "/openclaw/.clawsembly-gateway-home",
            module: moduleWithBytes,
            runWasix,
            runtime: wasixRuntime,
            stateDir: gatewayStateRoot
          });
          return {
            schemaVersion: 1 as const,
            status: "restored-from-opfs" as const,
            executor:
              "OPFS snapshot + new @wasmer/sdk Directory + Edge.js/WASIX",
            requiredEffects: {
              executions: [],
              packageStateDatabase
            },
            reviewedNonEffects: [],
            packageFiles: {
              mutated: false as const,
              verification:
                "immutable package remounted before scoped state recovery"
            }
          };
        })()
      : await (async () => {
          status.textContent =
            "Installing required OpenClaw lifecycle effects in the browser kernel…";
          return runOpenClawInstallLifecycle({
            directory: gatewayOpenclaw,
            homeDir: "/openclaw/.clawsembly-gateway-home",
            module: moduleWithBytes,
            runWasix,
            runtime: wasixRuntime,
            stateDir: gatewayStateRoot
          });
        })();
    await gatewayOpenclaw.writeFile(
      "/.clawsembly-gateway-state/openclaw.json",
      new TextEncoder().encode(JSON.stringify({
        gateway: {
          mode: "local",
          bind: "loopback"
        },
        agents: {
          defaults: {
            workspace: gatewayWorkspace,
            skipBootstrap: true,
            ...(agentTurnProof
              ? {
                  model: {
                    primary: `${providerName}/${providerModel}`
                  }
                }
              : {})
          }
        },
        ...(agentTurnProof
          ? {
              models: {
                providers: {
                  [providerName]: {
                    api: "openai-completions",
                    apiKey: providerApiKey,
                    baseUrl: providerBaseUrl,
                    models: [{
                      id: providerModel,
                      name: providerDisplayName,
                      reasoning: false,
                      input: ["text"],
                      cost: {
                        input: 0,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0
                      },
                      contextWindow: liveProviderProof ? 128_000 : 32_768,
                      maxTokens: liveProviderProof ? 128 : 256
                    }]
                  }
                }
              }
            }
          : {})
      }, null, 2))
    );
    const gatewayArgs = [
      "gateway",
      "run",
      "--allow-unconfigured",
      "--auth",
      "token",
      "--bind",
      "loopback",
      "--port",
      String(gatewayPort),
      "--tailscale",
      "off",
      "--verbose",
      "--ws-log",
      "full"
    ];
    const gatewayArgv = [
      "/bin/edge",
      "/openclaw/dist/entry.js",
      ...gatewayArgs
    ];
    const gatewayTimeoutMarker =
      `CLAWSEMBLY_GATEWAY_PROOF_TIMEOUT=${proofTimeoutMs}`;
    const gatewayHarness = [
      `process.argv=${JSON.stringify(gatewayArgv)};`,
      "console.error('CLAWSEMBLY_DIAGNOSTIC_NODE='+process.versions.node);",
      "const gatewayWatchdog=setTimeout(()=>{",
      `console.error(${JSON.stringify(gatewayTimeoutMarker)});`,
      "process.exit(124)",
      `},${proofTimeoutMs});`,
      "import('file:///openclaw/dist/entry.js').catch((error)=>{",
      "console.error(error?.stack??String(error));process.exit(1)",
      "});"
    ].join("");

    status.textContent = "Starting the exact unmodified OpenClaw Gateway…";
    const startedAt = performance.now();
    const gatewayInstance = await runWasix(moduleWithBytes, {
      program: "edgejs",
      args: ["-e", gatewayHarness],
      cwd: "/openclaw",
      env: {
        CLAWSEMBLY_DIAGNOSTIC_ONLY: "1",
        FORCE_COLOR: "0",
        HOME: "/openclaw/.clawsembly-gateway-home",
        NO_COLOR: "1",
        OPENCLAW_DEBUG: "1",
        OPENCLAW_GATEWAY_STARTUP_TRACE: "1",
        OPENCLAW_GATEWAY_TOKEN: gatewayToken,
        OPENCLAW_NO_RESPAWN: "1",
        OPENCLAW_STATE_DIR: "/openclaw/.clawsembly-gateway-state",
        PATH: "/bin"
      },
      mount: {
        "/openclaw": gatewayOpenclaw
      },
      runtime: wasixRuntime
    });
    const gatewayStdout = captureStream(gatewayInstance.stdout);
    const gatewayStderr = captureStream(gatewayInstance.stderr);
    const gatewayExit = gatewayInstance.wait().then((output) => ({
      kind: "gateway-exit" as const,
      output: output as WasixOutput
    }));
    const readiness = Promise.any([
      gatewayStdout.waitFor(readinessMarker, proofTimeoutMs),
      gatewayStderr.waitFor(readinessMarker, proofTimeoutMs)
    ]).then(
      () => ({ kind: "ready" as const }),
      (error) => ({
        error: error instanceof Error ? error.message : String(error),
        kind: "readiness-stream-ended" as const
      })
    );
    const startupHostTimeout = new Promise<{
      kind: "startup-host-timeout";
    }>((resolve) => {
      window.setTimeout(
        () => resolve({ kind: "startup-host-timeout" }),
        proofTimeoutMs + 5_000
      );
    });
    const startup = await Promise.race([
      gatewayExit,
      readiness,
      startupHostTimeout
    ]);

    if (startup.kind !== "ready") {
      if (startup.kind === "gateway-exit") {
        await Promise.all([gatewayStdout.done, gatewayStderr.done]);
      } else {
        await Promise.allSettled([
          gatewayStdout.cancel(),
          gatewayStderr.cancel()
        ]);
      }
      const evidence = {
        schemaVersion: 1,
        status: "blocked",
        blocker: startup.kind,
        claim:
          "The exact unmodified Gateway did not reach its own ready log before "
          + "the process exited or the bounded browser deadline elapsed.",
        notNorthStarCompletion,
        crossOriginIsolated,
        executor: "@wasmer/sdk + Edge.js QuickJS/WASIX",
        artifact: artifactEvidence,
        image: imageEvidence,
        openclaw: openclawEvidence,
        installLifecycle,
        ...(persistentStateRestore ? { persistentStateRestore } : {}),
        network: networkEvidence,
        isolation: isolationEvidence,
        launchHarness: launchHarnessEvidence,
        gateway: {
          args: gatewayArgs,
          elapsedMs: Math.round(performance.now() - startedAt),
          ...(startup.kind === "readiness-stream-ended"
            ? { readinessError: startup.error }
            : {}),
          result: startup.kind === "gateway-exit"
            ? {
                ...serializableOutput(startup.output),
                stdout: gatewayStdout.snapshot(),
                stderr: gatewayStderr.snapshot()
              }
            : {
                code: 125,
                ok: false,
                stdout: gatewayStdout.snapshot(),
                stderr: gatewayStderr.snapshot()
                  + `CLAWSEMBLY_GATEWAY_HOST_TIMEOUT=${proofTimeoutMs + 5_000}\n`
              }
        }
      };
      status.dataset.state = "pass";
      status.textContent =
        "MILESTONE · Gateway readiness blocker captured";
      result.textContent = JSON.stringify(
        redactSensitiveValues(evidence, sensitiveValues),
        null,
        2
      );
      return;
    }

    const readyElapsedMs = Math.round(performance.now() - startedAt);
    status.textContent =
      "Gateway listening; waiting for post-ready plugin prewarm…";
    await Promise.any([
      gatewayStdout.waitFor(clientLaunchMarker, 30_000),
      gatewayStderr.waitFor(clientLaunchMarker, 30_000)
    ]);
    const clientLaunchElapsedMs = Math.round(
      performance.now() - startedAt
    );
    status.textContent = agentTurnProof
      ? directLiveProviderProof
        ? "Gateway ready; starting a live-provider OpenClaw agent turn…"
        : brokeredLiveProviderProof
          ? "Gateway ready; starting a brokered live OpenClaw agent turn…"
        : "Gateway ready; starting an official OpenClaw agent turn…"
      : "Gateway ready; starting the official OpenClaw health client…";
    const clientArgs = agentTurnProof
      ? [
          "/openclaw/dist/entry.js",
          "agent",
          "--agent",
          "main",
          "--message",
          `Reply exactly: ${agentTurnMarker}`,
          "--thinking",
          "off",
          "--timeout",
          String(agentTurnTimeoutSeconds),
          "--json"
        ]
      : [
          "/openclaw/dist/entry.js",
          "gateway",
          "call",
          "health",
          "--url",
          gatewayUrl,
          "--token",
          gatewayToken,
          "--timeout",
          "60000",
          "--json"
        ];
    const clientArgv = ["/bin/edge", ...clientArgs];
    const clientProofTimeoutMs = agentTurnProof
      ? Math.min(150_000, proofTimeoutMs)
      : Math.min(105_000, proofTimeoutMs);
    const clientTimeoutMarker =
      `CLAWSEMBLY_CLIENT_PROOF_TIMEOUT=${clientProofTimeoutMs}`;
    const runClientAttempt = async (attempt: number) => {
      const clientStateRoot =
        `/openclaw/.clawsembly-client-state-${attempt}`;
      const clientHarness = [
        `process.argv=${JSON.stringify(clientArgv)};`,
        "console.error('CLAWSEMBLY_CLIENT_STARTED='+process.versions.node);",
        "console.error('CLAWSEMBLY_CLIENT_WATCHDOG_START');",
        "const clientWatchdog=setTimeout(()=>{",
        `console.error(${JSON.stringify(clientTimeoutMarker)});`,
        "process.exit(124)",
        `},${clientProofTimeoutMs});`,
        "console.error('CLAWSEMBLY_CLIENT_WATCHDOG_ARMED');",
        "console.error('CLAWSEMBLY_CLIENT_IMPORT_START');",
        "const clientEntry=import('file:///openclaw/dist/entry.js');",
        "console.error('CLAWSEMBLY_CLIENT_IMPORT_ENQUEUED');",
        "clientEntry.then(()=>{",
        "console.error('CLAWSEMBLY_CLIENT_ENTRY_SETTLED');",
        "setTimeout(()=>{",
        "clearTimeout(clientWatchdog);process.exit(process.exitCode??0)",
        `},${clientCompletionGraceMs})`,
        "}).catch((error)=>{",
        "console.error(error?.stack??String(error));process.exit(1)",
        "});"
      ].join("");
      const clientInstance = await runWasix(moduleWithBytes, {
        program: "edgejs",
        args: ["-e", clientHarness],
        cwd: "/openclaw",
        env: {
          CLAWSEMBLY_DIAGNOSTIC_ONLY: "1",
          FORCE_COLOR: "0",
          HOME: `/openclaw/.clawsembly-client-home-${attempt}`,
          NO_COLOR: "1",
          OPENCLAW_GATEWAY_TOKEN: gatewayToken,
          OPENCLAW_NO_RESPAWN: "1",
          OPENCLAW_STATE_DIR: clientStateRoot,
          PATH: "/bin"
        },
        mount: {
          "/openclaw": clientOpenclaw
        },
        runtime: wasixRuntime
      });
      const clientStdout = captureStream(clientInstance.stdout);
      const clientStderr = captureStream(clientInstance.stderr);
      const elapsedMs = performance.now() - startedAt;
      const remainingMs = Math.max(
        1_000,
        Math.min(
          clientProofTimeoutMs + 5_000,
          proofTimeoutMs - elapsedMs
        )
      );
      const outcome = await Promise.race([
        clientInstance.wait().then((output) => ({
          kind: "client-exit" as const,
          output: output as WasixOutput
        })),
        clientStdout.waitUntil((captured) => {
          try {
            const parsedOutput = parseJsonOutput(captured);
            return agentTurnProof
              ? isCompletedAgentTurnResponse(parsedOutput, agentTurnMarker)
              : isHealthyResponse(parsedOutput);
          } catch {
            return false;
          }
        }, agentTurnProof
          ? "a complete OpenClaw agent-turn JSON response"
          : "a complete healthy Gateway JSON response", remainingMs).then(
          () => ({
              kind: "client-proof-output" as const
          }),
          () => new Promise<never>(() => {})
        ),
        gatewayExit,
        new Promise<{ kind: "client-host-timeout" }>((resolve) => {
          window.setTimeout(
            () => resolve({ kind: "client-host-timeout" }),
            remainingMs
          );
        })
      ]);

      if (outcome.kind === "client-exit") {
        await Promise.all([clientStdout.done, clientStderr.done]);
      } else {
        void clientStdout.cancel();
        void clientStderr.cancel();
      }
      if (outcome.kind === "gateway-exit") {
        await Promise.all([gatewayStdout.done, gatewayStderr.done]);
      }
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 1_000);
      });
      const attemptResult = outcome.kind === "client-exit"
        ? {
            ...serializableOutput(outcome.output),
            stdout: clientStdout.snapshot(),
            stderr: clientStderr.snapshot()
          }
        : outcome.kind === "client-proof-output"
          ? {
              code: null,
              ok: true,
              stdout: clientStdout.snapshot(),
              stderr: clientStderr.snapshot()
            }
          : {
              code: outcome.kind === "gateway-exit" ? 126 : 125,
              ok: false,
              stdout: clientStdout.snapshot(),
              stderr: clientStderr.snapshot()
                + `CLAWSEMBLY_CLIENT_${outcome.kind.toUpperCase().replaceAll("-", "_")}\n`
            };
      let attemptResponse: unknown;
      let responseParseError: string | undefined;
      if (attemptResult.stdout.trim()) {
        try {
          attemptResponse = parseJsonOutput(attemptResult.stdout);
        } catch (error) {
          responseParseError = error instanceof Error
            ? error.message
            : String(error);
        }
      }
      const attemptPassed = agentTurnProof
        ? isCompletedAgentTurnResponse(attemptResponse, agentTurnMarker)
        : isHealthyResponse(attemptResponse);
      return {
        attempt,
        stateRoot: clientStateRoot,
        outcome: outcome.kind,
        completion: attemptPassed
          ? outcome.kind === "client-exit" && attemptResult.code === 0
            ? "client-exit-zero"
            : agentTurnProof
              ? "agent-turn-output-observed"
              : "health-output-observed"
          : outcome.kind,
        result: attemptResult,
        health: attemptResponse,
        ...(responseParseError
          ? { healthParseError: responseParseError }
          : {}),
        passed: attemptPassed,
        retryableTransportError:
          outcome.kind === "client-exit"
          && !attemptResult.ok
          && attemptResult.stdout.includes("gateway_transport_error"),
        gatewayOutput:
          outcome.kind === "gateway-exit"
            ? serializableOutput(outcome.output)
            : undefined
      };
    };

    const clientAttempts: Array<
      Awaited<ReturnType<typeof runClientAttempt>>
    > = [];
    for (let attempt = 1; attempt <= maxClientAttempts; attempt += 1) {
      status.textContent =
        `Gateway ready; running official ${
          agentTurnProof ? "agent-turn" : "health"
        } client (${attempt}/${maxClientAttempts})…`;
      const clientAttempt = await runClientAttempt(attempt);
      clientAttempts.push(clientAttempt);
      if (clientAttempt.passed) break;
      const enoughTimeForRetry =
        performance.now() - startedAt < proofTimeoutMs - 45_000;
      if (
        !clientAttempt.retryableTransportError
        || !enoughTimeForRetry
      ) {
        break;
      }
    }
    const successfulClient = clientAttempts.find(
      (attempt) => attempt.passed
    );
    const selectedClient =
      successfulClient ?? clientAttempts[clientAttempts.length - 1];
    if (!selectedClient) {
      throw new Error("No official OpenClaw client attempt was executed");
    }
    const proofPassed = successfulClient !== undefined;
    const gatewayExitedDuringClient = clientAttempts.some(
      (attempt) => attempt.outcome === "gateway-exit"
    );
    const gatewayOutput = clientAttempts.find(
      (attempt) => attempt.gatewayOutput !== undefined
    )?.gatewayOutput;
    const evidence = {
      schemaVersion: 1,
      status: proofPassed
        ? agentTurnProof
          ? directLiveProviderProof
            ? "live-agent-turn-pass"
            : brokeredLiveProviderProof
              ? "brokered-live-agent-turn-pass"
            : "agent-turn-pass"
          : "gateway-health-pass"
        : "blocked",
      ...(proofPassed
        ? {}
        : {
            blocker: selectedClient.retryableTransportError
              ? "gateway-client-transport-error"
              : selectedClient.outcome
          }),
      claim: proofPassed
        ? agentTurnProof
          ? directLiveProviderProof
            ? "A second browser guest executed the exact official OpenClaw "
              + "CLI, submitted a real agent turn through the unmodified "
              + "Gateway, and received a live GitHub Models reply over "
              + "guest-validated TLS through an exact-host capability relay."
            : brokeredLiveProviderProof
              ? "A second browser guest executed the exact official OpenClaw "
                + "CLI, submitted a real agent turn through the unmodified "
                + "Gateway, and received a live GitHub Models reply while "
                + "only an opaque operation capability entered the browser; "
                + "the provider credential remained in the OSS host broker."
            : "A second browser guest executed the exact official OpenClaw "
              + "CLI, submitted a real agent turn through the unmodified "
              + "Gateway, and received the deterministic model reply through "
              + "the capability-scoped TCP relay."
          : "A second browser guest executed the exact official OpenClaw CLI "
            + "and completed an authenticated health RPC against the real "
            + "unmodified Gateway over browser-local loopback."
        : agentTurnProof
          ? "The real Gateway reached readiness, but its official client did "
            + "not complete a valid agent turn."
          : "The real Gateway reached readiness, but its official client did "
            + "not complete a valid authenticated health RPC.",
      notNorthStarCompletion,
      crossOriginIsolated,
      executor: "@wasmer/sdk + Edge.js QuickJS/WASIX",
      artifact: artifactEvidence,
      image: imageEvidence,
      openclaw: openclawEvidence,
      installLifecycle,
      ...(persistentStateRestore ? { persistentStateRestore } : {}),
      network: networkEvidence,
      isolation: isolationEvidence,
      launchHarness: launchHarnessEvidence,
      ...(agentTurnProof
        ? {
            agentResponseValidation: {
              contract: "strict-assistant-payload-v1",
              expectedText: agentTurnMarker,
              acceptedTextSources: [
                "result.payloads[].text",
                "result.meta.finalAssistantVisibleText",
                "result.meta.finalAssistantRawText"
              ],
              requiredOutcome:
                "status=ok; summary=completed; aborted=false; "
                + "stopReason=stop; fallbackUsed=false; "
                + "assistant-stage success",
              arbitraryMetadataSearched: false,
              promptEchoesAccepted: false
            }
          }
        : {}),
      gateway: {
        args: gatewayArgs,
        readinessMarker,
        clientLaunchMarker,
        clientLaunchElapsedMs,
        readyElapsedMs,
        state: gatewayExitedDuringClient
          ? proofPassed
            ? agentTurnProof
              ? "exited-after-agent-turn-output"
              : "exited-after-health-output"
            : "exited-before-health-completed"
          : agentTurnProof
            ? "running-at-agent-turn-proof"
            : "running-at-health-proof",
        ...(gatewayOutput
          ? {
              result: {
                ...gatewayOutput,
                stdout: gatewayStdout.snapshot(),
                stderr: gatewayStderr.snapshot()
              }
            }
          : {}),
        stdout: gatewayStdout.snapshot(),
        stderr: gatewayStderr.snapshot()
      },
      ...(proofKind === "agent-turn"
        ? {
            providerFixture: {
              api: "openai-completions",
              baseUrl: providerBaseUrl,
              expectedMarker: agentTurnMarker,
              model: `${providerName}/${providerModel}`
            }
          }
        : {}),
      ...(directLiveProviderProof
        ? {
            liveProvider: {
              api: "openai-completions",
              authentication: {
                credential: "job-scoped GITHUB_TOKEN",
                providerEgress: "models.github.ai:443 DNS-derived TCP grant",
                recorded: false,
                repositoryContentsPermission: "none",
                workflowPermissions: ["models: read"]
              },
              baseUrl: providerBaseUrl,
              expectedMarker: agentTurnMarker,
              model: `${providerName}/${providerModel}`,
              tls: {
                authority: providerHost,
                terminatedByRelay: false,
                validation: "guest Node TLS/SNI certificate validation"
              }
            }
          }
        : {}),
      ...(brokeredLiveProviderProof
        ? {
            credentialBroker: {
              api: "openai-completions",
              browserReceivesProviderCredential: false,
              guestEndpoint: providerBaseUrl,
              guestOperationCapability: {
                authority:
                  `POST ${providerBaseUrl}/chat/completions`,
                model: providerModel,
                recorded: false,
                streamingRequired: true
              },
              expectedMarker: agentTurnMarker,
              model: `${providerName}/${providerModel}`,
              provider: {
                authentication: {
                  credential: "job-scoped GITHUB_TOKEN",
                  recorded: false,
                  repositoryContentsPermission: "none",
                  workflowPermissions: ["models: read"]
                },
                endpoint:
                  "https://models.github.ai/inference/chat/completions",
                model: providerModel,
                tls: {
                  authority: "models.github.ai",
                  terminatedBy: "clawsembly-provider-broker",
                  validation:
                    "Rustls HTTPS with platform certificate validation",
                  visibleToGuest: false
                }
              },
              security: {
                exactEndpointAndModel: true,
                loopbackOnly: true,
                maxConcurrency: 1,
                maxRequestBytes: 2_097_152,
                maxRequests: 1,
                maxResponseBytes: 2_097_152,
                redirects: "disabled",
                systemProxy: "disabled"
              }
            }
          }
        : {}),
      client: {
        args: clientArgs.slice(1),
        distinctGuestProcess: true,
        maxAttempts: maxClientAttempts,
        selectedAttempt: selectedClient.attempt,
        completion: selectedClient.completion,
        attempts: clientAttempts.map((attempt) => ({
          attempt: attempt.attempt,
          stateRoot: attempt.stateRoot,
          outcome: attempt.outcome,
          completion: attempt.completion,
          result: attempt.result,
          health: attempt.health,
          ...(attempt.healthParseError
            ? { healthParseError: attempt.healthParseError }
            : {})
        })),
        result: selectedClient.result,
        health: selectedClient.health,
        ...(selectedClient.healthParseError
          ? { healthParseError: selectedClient.healthParseError }
          : {})
      }
    };
    status.dataset.state = "pass";
    status.textContent = proofPassed
      ? agentTurnProof
        ? directLiveProviderProof
          ? "PASS · Unmodified OpenClaw completed a live TLS agent turn"
          : brokeredLiveProviderProof
            ? "PASS · Unmodified OpenClaw completed a brokered live agent turn"
          : "PASS · Unmodified OpenClaw completed a real agent turn"
        : "PASS · Official OpenClaw client completed Gateway health RPC"
      : "MILESTONE · Gateway client blocker captured";
    result.textContent = JSON.stringify(
      redactSensitiveValues(evidence, sensitiveValues),
      null,
      2
    );
  } catch (error) {
    status.dataset.state = "fail";
    status.textContent = "FAIL";
    const errorText = error instanceof Error
      ? `${error.message}\n${error.stack ?? ""}`
      : String(error);
    result.textContent = redactSensitiveValues(errorText, sensitiveValues);
  }
}

void runProbe();
