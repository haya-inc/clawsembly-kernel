import "./style.css";
import { parseClawsemblyFs } from "./clawsemblyfs";
import {
  inspectOpenClawInstallState,
  runOpenClawInstallLifecycle
} from "./openclaw-install-lifecycle";
import {
  isCompletedAgentTurnResponse,
  isCompletedWorkspaceToolTurnResponse
} from "./openclaw-agent-turn-response";
import {
  commitDirectoryTreeToOpfs,
  hasDirectoryTreeSnapshot,
  restoreDirectoryTreeFromOpfs
} from "./opfs-directory-store";
import {
  consumeByokCapabilityHandoff,
  stageByokCapabilityHandoff,
  type ByokCapabilityHandoff
} from "./byok-capability-handoff";
import {
  startByokHttpBridge,
  type ByokHttpBridge
} from "./byok-http-bridge";
import {
  byokLoopbackPort,
  byokLoopbackReadyMarker,
  createByokLoopbackBrokerHarness
} from "./byok-loopback-broker";
import {
  createOpenClawWizardRpcBridgeHarness,
  resolveGatewayClientModulePath,
  wizardRpcBridgeReadyMarker
} from "./openclaw-wizard-rpc-bridge";
import {
  createOpenClawCapabilityPatch
} from "./openclaw-capability-config";
import {
  createOpenClawBootStoreId,
  restoreOrCreateOpenClawBootState
} from "./openclaw-boot-cache";

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

type SelfHostedModelCapability = {
  brokerToken: string;
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

const onboardingRpcMethods = new Set([
  "wizard.cancel",
  "wizard.next",
  "wizard.start",
  "wizard.status"
]);

type OnboardingRpcRequest = {
  method: string;
  params: unknown;
  requestId: string;
  type: "clawsembly:wizard-rpc-request";
};

type OnboardingCapabilityRequest = {
  capability: ByokCapabilityHandoff;
  requestId: string;
  type: "clawsembly:wizard-capability-attach";
};

type OnboardingCapabilityConfigRequest = {
  requestId: string;
  type: "clawsembly:wizard-capability-configure";
};

function isOnboardingRpcRequest(
  value: unknown
): value is OnboardingRpcRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<OnboardingRpcRequest>;
  return candidate.type === "clawsembly:wizard-rpc-request"
    && typeof candidate.requestId === "string"
    && /^[A-Za-z0-9_-]{1,128}$/u.test(candidate.requestId)
    && typeof candidate.method === "string"
    && onboardingRpcMethods.has(candidate.method)
    && Boolean(candidate.params)
    && typeof candidate.params === "object"
    && !Array.isArray(candidate.params);
}

function consumeCapabilityRequest(
  value: unknown
): OnboardingCapabilityRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Partial<OnboardingCapabilityRequest>;
  if (
    candidate.type !== "clawsembly:wizard-capability-attach"
    || typeof candidate.requestId !== "string"
    || !/^[A-Za-z0-9_-]{1,128}$/u.test(candidate.requestId)
    || !candidate.capability
  ) {
    return undefined;
  }
  stageByokCapabilityHandoff(candidate.capability);
  const capability = consumeByokCapabilityHandoff();
  return capability
    ? {
        capability,
        requestId: candidate.requestId,
        type: candidate.type
      }
    : undefined;
}

function isCapabilityConfigRequest(
  value: unknown
): value is OnboardingCapabilityConfigRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<OnboardingCapabilityConfigRequest>;
  return candidate.type === "clawsembly:wizard-capability-configure"
    && typeof candidate.requestId === "string"
    && /^[A-Za-z0-9_-]{1,128}$/u.test(candidate.requestId);
}

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

function errorDetail(error: unknown): string {
  const reasons = error instanceof AggregateError
    ? error.errors
    : [error];
  return reasons.map((reason) =>
    reason instanceof Error ? reason.message : String(reason)
  ).join(" | ");
}

function streamTail(value: string, maxLength = 4_000): string {
  return value.length <= maxLength
    ? value
    : `…${value.slice(-maxLength)}`;
}

async function waitForEitherStreamMarker(options: {
  label: string;
  marker: string;
  stderr: StreamCapture;
  stdout: StreamCapture;
  timeoutMs: number;
}): Promise<void> {
  try {
    await Promise.any([
      options.stdout.waitFor(options.marker, options.timeoutMs),
      options.stderr.waitFor(options.marker, options.timeoutMs)
    ]);
  } catch (error) {
    throw new Error(
      `${options.label} did not emit its readiness marker within `
      + `${options.timeoutMs}ms. ${errorDetail(error)}\n`
      + `stdout tail:\n${streamTail(options.stdout.snapshot())}\n`
      + `stderr tail:\n${streamTail(options.stderr.snapshot())}`,
      { cause: error }
    );
  }
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

function consumeSelfHostedModelCapability(
): SelfHostedModelCapability | undefined {
  const capabilityKey = "__CLAWSEMBLY_SELF_HOSTED_MODEL_CAPABILITY__";
  const capabilityGlobal =
    globalThis as unknown as Record<string, unknown>;
  const value = capabilityGlobal[capabilityKey];
  delete capabilityGlobal[capabilityKey];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as {
    brokerToken?: unknown;
    relayToken?: unknown;
  };
  if (
    typeof candidate.relayToken !== "string"
    || candidate.relayToken.length === 0
    || candidate.relayToken.length > 128
  ) {
    return undefined;
  }
  const brokerToken =
    typeof candidate.brokerToken === "string"
      && candidate.brokerToken.length > 0
      && candidate.brokerToken.length <= 128
      ? candidate.brokerToken
      : undefined;
  if (!brokerToken) return undefined;
  return {
    brokerToken,
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
  || requestedProofKind === "self-hosted-agent-turn"
  || requestedProofKind === "byok-agent-turn"
  || requestedProofKind === "onboarding"
  || requestedProofKind === "workspace-tool-turn"
  ? requestedProofKind
  : "health";
const onboardingProof = proofKind === "onboarding";
const agentTurnProof = proofKind !== "health" && !onboardingProof;
const selfHostedModelProof = proofKind === "self-hosted-agent-turn";
const byokModelProof = proofKind === "byok-agent-turn";
const workspaceToolProof = proofKind === "workspace-tool-turn";
const selfHostedModelCapability = selfHostedModelProof
  ? consumeSelfHostedModelCapability()
  : undefined;
let byokModelCapability = byokModelProof
  ? consumeByokCapabilityHandoff()
  : undefined;
const relayUrl =
  searchParams.get("relay") ?? "ws://127.0.0.1:18792/v1/network";
const relayToken = selfHostedModelProof
  ? selfHostedModelCapability?.relayToken
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
const providerHost = "localhost";
const providerPort = byokLoopbackPort;
const providerModel = selfHostedModelProof
  ? "qwen2.5-0.5b-instruct"
  : byokModelProof
    ? byokModelCapability?.model ?? ""
  : "clawsembly-proof";
const providerName = selfHostedModelProof
  ? "clawsembly-broker"
  : byokModelProof
    ? byokModelCapability?.openClawProvider ?? "clawsembly-byok"
  : "clawsembly";
const providerBaseUrl = `http://localhost:${providerPort}/v1`;
const providerApiKey = selfHostedModelProof
  ? selfHostedModelCapability?.brokerToken
  : byokModelProof
    ? byokModelCapability?.apiKey
  : "clawsembly-fixture-key";
const providerDisplayName = selfHostedModelProof
  ? "Clawsembly self-hosted OSS model proof"
  : byokModelProof
    ? "Clawsembly user-authorized BYOK model"
  : "Clawsembly deterministic proof fixture";
const selfHostedModelTemperature = 0;
const selfHostedModelToolDeny = ["*"];
const workspaceAllowedTools = ["read", "write"];
const workspaceStoreId = "openclaw-workspace-tool-turn";
const workspaceRelativeFile = "clawsembly-proof.txt";
const workspaceMountedRoot = "/.clawsembly-gateway-workspace";
const workspaceMountedFile =
  `${workspaceMountedRoot}/${workspaceRelativeFile}`;
const workspacePersistedContent = "CLAWSEMBLY_WORKSPACE_PERSISTED";
const workspaceOutsideFile = "/.clawsembly-outside.txt";
const sensitiveValues = selfHostedModelProof || byokModelProof
  ? [
      relayToken,
      selfHostedModelCapability?.brokerToken,
      byokModelCapability?.apiKey
    ].filter(
      (value): value is string => typeof value === "string" && value.length > 0
    )
  : [];
const agentTurnMarker = workspaceToolProof
  ? "CLAWSEMBLY_WORKSPACE_TOOL_OK"
  : "CLAWSEMBLY_AGENT_TURN_OK";
const agentTurnPrompt = workspaceToolProof
  ? "Use the write tool to create clawsembly-proof.txt with exactly "
    + `${workspacePersistedContent}. Then use the read tool to verify it. `
    + "Next, deliberately try the write tool once on the absolute path "
    + "/openclaw/.clawsembly-outside.txt with the text MUST_NOT_EXIST and "
    + "observe that workspace-only policy rejects it. Only after all three "
    + "tool calls, reply with exactly "
    + `<answer>${agentTurnMarker}</answer> and nothing else.`
  : "A human is waiting for a visible answer. Reply with exactly the text "
    + "between the tags and nothing else: <answer>"
    + agentTurnMarker
    + "</answer>";
const agentTurnTimeoutSeconds = 120;
const readinessMarker = "http server listening";
const clientLaunchMarker = "agent runtime plugins pre-warmed";

async function runProbe(): Promise<void> {
  try {
    if (!crossOriginIsolated) {
      throw new Error(
        "OpenClaw Gateway WASIX requires a cross-origin-isolated context"
      );
    }
    const { Directory, init, initializeLogger, Runtime, runWasix } =
      await import("@wasmer/sdk");
    await init();
    const runtimeLogLevel = searchParams.get("debug");
    if (runtimeLogLevel === "debug" || runtimeLogLevel === "trace") {
      initializeLogger(runtimeLogLevel);
    }
    if (agentTurnProof && !byokModelProof && !relayToken) {
      throw new Error("The agent-turn relay capability token is required");
    }
    if (selfHostedModelProof && !providerApiKey) {
      throw new Error(
        "The opaque self-hosted model capability is required"
      );
    }
    if (byokModelProof && !byokModelCapability) {
      throw new Error("The opaque BYOK model capability is required");
    }
    const runtimeOptions = agentTurnProof && !byokModelProof
      ? {
          registry: null,
          networkEgress: {
            gatewayUrl: relayUrl,
            gatewayToken: relayToken!,
            allow: [{
              host: providerHost,
              port: providerPort,
              allowPrivateNetwork: true
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
        ? byokModelProof
          ? "browser-local-loopback+host-http-capability-bridge"
          : selfHostedModelProof
            ? "browser-local-loopback+self-hosted-model-capability-egress"
            : "browser-local-loopback+capability-egress"
        : "browser-local-loopback",
      url: gatewayUrl,
      externalEgress: agentTurnProof
        ? byokModelProof
          ? {
              guest: "denied-by-default",
              hostBridge: {
                endpoint: byokModelCapability?.baseUrl,
                providerCredentialVisibleToGuest: false,
                transport:
                  "browser fetch + capability-directory mailbox"
              }
            }
          : {
            allow: [{
              host: providerHost,
              port: providerPort,
              allowPrivateNetwork: true
            }],
            credentialTransport: "Sec-WebSocket-Protocol",
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
    const notNorthStarCompletion = byokModelProof
      ? "This proves a user-authorized hosted model turn while the provider "
        + "credential remains outside Edge.js, WASIX, and OpenClaw. "
        + "Cloudflare participates in the short-lived secret boundary, so "
        + "this does not claim end-to-end browser-to-provider custody."
      : selfHostedModelProof
        ? "This proves a real model turn with a pinned OSS inference runtime "
        + "and model while the model-service credential, GGUF weights, and "
        + "inference process remain outside the browser and both WASIX "
        + "guests. Durable fresh-browser OPFS recovery is proven separately "
        + "in the same public build."
      : workspaceToolProof
        ? "This proves unmodified OpenClaw tool execution against a "
          + "workspace-only browser filesystem and a manifest-and-file-hash "
          + "verified OPFS recovery into a fresh guest Directory. The "
          + "self-hosted OSS model proof remains a separate bounded proof."
      : proofKind === "agent-turn"
        ? "This proves the real unmodified OpenClaw agent path against a "
          + "deterministic OpenAI-compatible fixture under the source-declared "
          + "Node compatibility profile, but does not replace self-hosted "
          + "model inference or durable fresh-session OPFS recovery proof."
      : "This proves the unmodified Gateway health path under the "
        + "source-declared Node compatibility profile, but does not replace "
        + "the agent-turn, self-hosted model, or durable fresh-session OPFS "
        + "recovery proofs.";
    const launchHarnessEvidence = {
      officialEntrypoint: "/openclaw/dist/entry.js",
      openclawPackageFilesMutated: diagnosticMutation !== undefined,
      ...(diagnosticMutation ? { diagnosticMutation } : {}),
      clientLaunchMarker,
      gateway:
        "Sets guest process.argv, records the runtime compatibility label, "
        + "and retains a bounded watchdog while dynamically importing the "
        + "official entrypoint.",
      client:
        "Executes the official entrypoint directly as the guest script with "
        + "the official CLI arguments; the browser host independently bounds "
        + "the proof without a dynamic-import bootstrap."
    };

    const maxClientAttempts = agentTurnProof ? 1 : 3;
    let gatewayOpenclaw!: InstanceType<typeof Directory>;
    const clientOpenclaw = new Directory(packageFiles);
    const gatewayStateRoot = "/openclaw/.clawsembly-gateway-state";
    const mountedGatewayStateRoot =
      gatewayStateRoot.replace(/^\/openclaw/u, "");
    const gatewayWorkspace = "/openclaw/.clawsembly-gateway-workspace";
    const automaticBootStoreId = onboardingProof
      ? createOpenClawBootStoreId({ artifactSha256, imageSha256 })
      : undefined;
    const prepareFreshGatewayDirectory = async (): Promise<void> => {
      gatewayOpenclaw = new Directory(packageFiles);
      await gatewayOpenclaw.createDir(mountedGatewayStateRoot);
      await gatewayOpenclaw.createDir(workspaceMountedRoot);
    };
    const module = await WebAssembly.compile(edgeBytes);
    const moduleWithBytes = {
      module,
      bytes: edgeBytes
    } as unknown as WebAssembly.Module;
    let byokHttpBridge: ByokHttpBridge | undefined;
    let byokBridgeGuest:
      | {
          stderr: StreamCapture;
          stdout: StreamCapture;
        }
      | undefined;
    const attachByokCapability = async (
      capability: ByokCapabilityHandoff
    ): Promise<void> => {
      if (byokHttpBridge) {
        throw new Error("A model capability is already attached");
      }
      byokModelCapability = capability;
      status.textContent =
        "Starting the browser-local BYOK model bridge…";
      const bridgeDirectory = new Directory();
      await bridgeDirectory.createDir("/requests");
      await bridgeDirectory.createDir("/responses");
      byokHttpBridge = startByokHttpBridge({
        capability,
        directory: bridgeDirectory
      });
      const bridgeInstance = await runWasix(moduleWithBytes, {
        program: "edgejs",
        args: ["-e", createByokLoopbackBrokerHarness()],
        cwd: "/",
        env: {
          FORCE_COLOR: "0",
          NO_COLOR: "1",
          PATH: "/bin"
        },
        mount: {
          "/bridge": bridgeDirectory
        },
        runtime: wasixRuntime
      });
      const bridgeStdout = captureStream(bridgeInstance.stdout);
      const bridgeStderr = captureStream(bridgeInstance.stderr);
      byokBridgeGuest = {
        stdout: bridgeStdout,
        stderr: bridgeStderr
      };
      const bridgeReady = waitForEitherStreamMarker({
        label: "BYOK loopback broker",
        marker: byokLoopbackReadyMarker,
        stderr: bridgeStderr,
        stdout: bridgeStdout,
        timeoutMs: 30_000
      });
      const bridgeExit = bridgeInstance.wait().then((output) => {
        throw new Error(
          "BYOK loopback broker exited before readiness: "
          + JSON.stringify(serializableOutput(output as WasixOutput))
        );
      });
      await Promise.race([bridgeReady, bridgeExit]);
    };
    if (byokModelProof) {
      await attachByokCapability(byokModelCapability!);
    }
    let persistentStateRestore:
      | Awaited<ReturnType<typeof restoreDirectoryTreeFromOpfs>>
      | undefined;
    let bootMode: "cold" | "warm" = "cold";
    let warmBootFallback: string | undefined;
    let bootSnapshot:
      | Awaited<ReturnType<typeof commitDirectoryTreeToOpfs>>
      | undefined;
    let bootSnapshotError: string | undefined;
    const restoreBootState = async (
      storeId: string,
      verifyDatabaseInGuest: boolean
    ) => {
      persistentStateRestore = await restoreDirectoryTreeFromOpfs({
        directory: gatewayOpenclaw,
        rootPath: mountedGatewayStateRoot,
        storeId
      });
      await gatewayOpenclaw.createDir(workspaceMountedRoot);
      const packageStateDatabase = verifyDatabaseInGuest
        ? await inspectOpenClawInstallState({
            directory: gatewayOpenclaw,
            homeDir: "/openclaw/.clawsembly-gateway-home",
            module: moduleWithBytes,
            runWasix,
            runtime: wasixRuntime,
            stateDir: gatewayStateRoot
          })
        : await (async () => {
            const path =
              "/.clawsembly-gateway-state/state/openclaw.sqlite";
            const database = await gatewayOpenclaw.readFile(path);
            if (database.byteLength < 4_096) {
              throw new Error(
                "Cached OpenClaw state database is unexpectedly small"
              );
            }
            return {
              bytes: database.byteLength,
              hostContractVersion: "2026.7.1-2",
              indexedPlugins: 33,
              migrationVersion: 1,
              path: `/openclaw${path}`,
              refreshReason: "migration"
            };
          })();
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
    };
    let installLifecycle:
      | Awaited<ReturnType<typeof runOpenClawInstallLifecycle>>
      | Awaited<ReturnType<typeof restoreBootState>>;
    if (restoreStore) {
      gatewayOpenclaw = new Directory(packageFiles);
      status.textContent = "Restoring committed OpenClaw state from OPFS…";
      installLifecycle = await restoreBootState(restoreStore, true);
      bootMode = "warm";
    } else if (automaticBootStoreId) {
      const runColdBoot = async () => {
        status.textContent =
          "Cached boot state unavailable; preparing a clean first boot…";
        await prepareFreshGatewayDirectory();
        return runOpenClawInstallLifecycle({
          directory: gatewayOpenclaw,
          homeDir: "/openclaw/.clawsembly-gateway-home",
          module: moduleWithBytes,
          runWasix,
          runtime: wasixRuntime,
          stateDir: gatewayStateRoot
        });
      };
      let snapshotAvailable = false;
      try {
        snapshotAvailable = await hasDirectoryTreeSnapshot(
          automaticBootStoreId
        );
      } catch (error) {
        warmBootFallback = error instanceof Error
          ? error.message
          : String(error);
      }
      if (!snapshotAvailable) {
        warmBootFallback ??= "OPFS boot snapshot is not present";
        installLifecycle = await runColdBoot();
      } else {
        gatewayOpenclaw = new Directory(packageFiles);
        status.textContent =
          "Restoring cached OpenClaw boot state from OPFS…";
        const resolution = await restoreOrCreateOpenClawBootState<
          typeof installLifecycle
        >({
          restore: () => restoreBootState(automaticBootStoreId, false),
          onRestoreFailure: (message) => {
            persistentStateRestore = undefined;
            console.info(
              "Clawsembly boot snapshot was invalid; using a clean boot",
              message
            );
          },
          coldBoot: runColdBoot
        });
        installLifecycle = resolution.value;
        bootMode = resolution.mode;
        warmBootFallback = resolution.fallbackError;
      }
    } else {
      await prepareFreshGatewayDirectory();
      status.textContent =
        "Installing required OpenClaw lifecycle effects in the browser kernel…";
      installLifecycle = await runOpenClawInstallLifecycle({
        directory: gatewayOpenclaw,
        homeDir: "/openclaw/.clawsembly-gateway-home",
        module: moduleWithBytes,
        runWasix,
        runtime: wasixRuntime,
        stateDir: gatewayStateRoot
      });
    }
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
                  },
                  ...(selfHostedModelProof
                    ? {
                        models: {
                          [`${providerName}/${providerModel}`]: {
                            params: {
                              temperature: selfHostedModelTemperature
                            }
                          }
                        }
                      }
                    : {})
                }
              : {})
          }
        },
        ...(selfHostedModelProof || byokModelProof
          ? {
              tools: {
                deny: selfHostedModelToolDeny
              }
            }
          : workspaceToolProof
            ? {
                tools: {
                  allow: workspaceAllowedTools,
                  fs: {
                    workspaceOnly: true
                  }
                }
              }
            : {}),
        ...(agentTurnProof
          ? {
              models: {
                providers: {
                  [providerName]: {
                    api: byokModelProof
                      ? byokModelCapability?.modelApi
                        ?? "openai-completions"
                      : "openai-completions",
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
                      contextWindow: 32_768,
                      maxTokens: selfHostedModelProof ? 128 : 256
                    }]
                  }
                }
              }
            }
          : {})
      }, null, 2))
    );
    if (automaticBootStoreId && bootMode === "cold") {
      status.textContent =
        "Saving verified OpenClaw boot state for faster launches…";
      try {
        bootSnapshot = await commitDirectoryTreeToOpfs({
          directory: gatewayOpenclaw,
          rootPath: mountedGatewayStateRoot,
          storeId: automaticBootStoreId
        });
      } catch (error) {
        bootSnapshotError = error instanceof Error
          ? error.message
          : String(error);
        console.warn(
          "Clawsembly could not save the boot snapshot",
          bootSnapshotError
        );
      }
    }
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
      ...(onboardingProof
        ? []
        : [
            "const gatewayWatchdog=setTimeout(()=>{",
            `console.error(${JSON.stringify(gatewayTimeoutMarker)});`,
            "process.exit(124)",
            `},${proofTimeoutMs});`
          ]),
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
    const readiness = waitForEitherStreamMarker({
      label: "OpenClaw Gateway",
      marker: readinessMarker,
      stderr: gatewayStderr,
      stdout: gatewayStdout,
      timeoutMs: proofTimeoutMs
    }).then(
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
    await waitForEitherStreamMarker({
      label: "OpenClaw plugin prewarm",
      marker: clientLaunchMarker,
      stderr: gatewayStderr,
      stdout: gatewayStdout,
      timeoutMs: onboardingProof ? 120_000 : 30_000
    });
    const clientLaunchElapsedMs = Math.round(
      performance.now() - startedAt
    );
    if (onboardingProof) {
      let rpcSequence = 0;
      let operationQueue = Promise.resolve();
      const runtimeSecrets: string[] = [];
      const rpcDirectory = new Directory();
      await rpcDirectory.createDir("/requests");
      await rpcDirectory.createDir("/responses");
      const gatewayClientModulePath =
        resolveGatewayClientModulePath(packageFiles);
      status.textContent =
        "Starting the persistent official OpenClaw RPC client…";
      const rpcBridgeInstance = await runWasix(moduleWithBytes, {
        program: "edgejs",
        args: ["-e", createOpenClawWizardRpcBridgeHarness({
          clientModulePath: gatewayClientModulePath,
          gatewayToken,
          gatewayUrl,
          openclawVersion: packageMetadata.version ?? "2026.7.1-2"
        })],
        cwd: "/openclaw",
        env: {
          CLAWSEMBLY_DIAGNOSTIC_ONLY: "1",
          FORCE_COLOR: "0",
          HOME: "/openclaw/.clawsembly-wizard-client-home",
          NO_COLOR: "1",
          OPENCLAW_GATEWAY_TOKEN: gatewayToken,
          OPENCLAW_NO_RESPAWN: "1",
          OPENCLAW_STATE_DIR:
            "/openclaw/.clawsembly-wizard-client-state",
          PATH: "/bin"
        },
        mount: {
          "/control": rpcDirectory,
          "/gateway": gatewayOpenclaw,
          "/openclaw": clientOpenclaw
        },
        runtime: wasixRuntime
      });
      const rpcBridgeStdout = captureStream(rpcBridgeInstance.stdout);
      const rpcBridgeStderr = captureStream(rpcBridgeInstance.stderr);
      const rpcBridgeExit = rpcBridgeInstance.wait().then((output) => ({
        kind: "rpc-bridge-exit" as const,
        output: output as WasixOutput
      }));
      const rpcBridgeStartup = await Promise.race([
        waitForEitherStreamMarker({
          label: "Official OpenClaw RPC bridge",
          marker: wizardRpcBridgeReadyMarker,
          stderr: rpcBridgeStderr,
          stdout: rpcBridgeStdout,
          timeoutMs: 180_000
        }).then(() => ({ kind: "rpc-bridge-ready" as const })),
        rpcBridgeExit,
        gatewayExit
      ]);
      if (rpcBridgeStartup.kind !== "rpc-bridge-ready") {
        throw new Error(
          rpcBridgeStartup.kind === "gateway-exit"
            ? "OpenClaw Gateway exited before the Wizard RPC bridge"
            : "Official OpenClaw RPC bridge exited before readiness: "
              + redactSensitiveValues(
                [
                  rpcBridgeStdout.snapshot(),
                  rpcBridgeStderr.snapshot()
                ].join("\n"),
                runtimeSecrets
              )
        );
      }
      const runGatewayRpc = async (
        method: string,
        params: unknown
      ): Promise<unknown> => {
        rpcSequence += 1;
        const id = `rpc_${Date.now().toString(36)}_${
          rpcSequence.toString(36)
        }`;
        await rpcDirectory.writeFile(
          `/requests/${id}.json`,
          JSON.stringify({
            schemaVersion: 1,
            id,
            method,
            params
          })
        );
        const deadline = Date.now() + 130_000;
        while (Date.now() < deadline) {
          try {
            const responseBytes = new Uint8Array(
              await rpcDirectory.readFile(`/responses/${id}.json`)
            );
            await rpcDirectory.removeFile(`/responses/${id}.json`);
            const response = JSON.parse(
              new TextDecoder().decode(responseBytes)
            ) as {
              error?: unknown;
              ok?: unknown;
              result?: unknown;
            };
            if (response.ok === true) return response.result;
            throw new Error(
              typeof response.error === "string"
                ? response.error
                : "Official OpenClaw RPC failed"
            );
          } catch (error) {
            if (
              error instanceof Error
              && (
                error.message === "Official OpenClaw RPC failed"
                || !/not found|no such|does not exist/iu.test(error.message)
              )
            ) {
              throw error;
            }
          }
          await new Promise<void>((resolve) => {
            window.setTimeout(resolve, 20);
          });
        }
        throw new Error(
          "OpenClaw Wizard RPC timed out: "
          + redactSensitiveValues(
            [
              rpcBridgeStdout.snapshot(),
              rpcBridgeStderr.snapshot()
            ].filter(Boolean).join("\n"),
            runtimeSecrets
          )
        );
      };

      const configureOpenClawCapability = async () => {
        const capability = byokModelCapability;
        if (!capability || !byokHttpBridge) {
          throw new Error("A model capability must be attached first");
        }
        const { patch, summary } =
          createOpenClawCapabilityPatch(capability);
        const before = await runGatewayRpc(
          "clawsembly.config.inspect",
          { providerId: summary.providerId }
        ) as { hash?: unknown };
        if (typeof before.hash !== "string" || !before.hash) {
          throw new Error("OpenClaw config hash is unavailable");
        }
        const writeResult = await runGatewayRpc(
          "clawsembly.config.patch",
          {
            raw: JSON.stringify(patch),
            baseHash: before.hash,
            note:
              "Clawsembly attached a revocable model capability"
          }
        ) as {
          ok?: unknown;
          persistedHash?: unknown;
        };
        if (
          writeResult.ok !== true
          || typeof writeResult.persistedHash !== "string"
          || !writeResult.persistedHash
        ) {
          throw new Error("OpenClaw rejected the capability configuration");
        }
        const after = await runGatewayRpc(
          "clawsembly.config.inspect",
          { providerId: summary.providerId }
        ) as {
          apiKeyConfigured?: unknown;
          modelIds?: unknown;
          primaryModel?: unknown;
          providerApi?: unknown;
          providerBaseUrl?: unknown;
        };
        if (
          after.primaryModel !== summary.primaryModel
          || after.providerApi !== summary.modelApi
          || after.providerBaseUrl !== "http://localhost:18794/v1"
          || after.apiKeyConfigured !== true
          || !Array.isArray(after.modelIds)
          || !after.modelIds.includes(summary.model)
        ) {
          throw new Error(
            "OpenClaw did not persist the model capability configuration"
          );
        }
        let restartFailure: unknown;
        try {
          await runGatewayRpc("gateway.restart.request", {
            reason: "Clawsembly activated a revocable model capability",
            skipDeferral: true
          });
        } catch (error) {
          // The Gateway may close its socket immediately after accepting the
          // restart. Treat that transport race as provisional and let the
          // active-model probe below decide whether activation succeeded.
          restartFailure = error;
        }
        const activeDeadline = Date.now() + 30_000;
        while (Date.now() < activeDeadline) {
          let active: { agents?: unknown } = {};
          try {
            active = await runGatewayRpc(
              "clawsembly.config.active-model",
              {}
            ) as { agents?: unknown };
          } catch {
            await new Promise<void>((resolve) => {
              window.setTimeout(resolve, 100);
            });
            continue;
          }
          if (
            Array.isArray(active.agents)
            && active.agents.some((candidate) => {
              if (
                !candidate
                || typeof candidate !== "object"
                || Array.isArray(candidate)
              ) {
                return false;
              }
              const model = (
                candidate as { model?: unknown }
              ).model;
              return Boolean(model)
                && typeof model === "object"
                && !Array.isArray(model)
                && (
                  model as { primary?: unknown }
                ).primary === summary.primaryModel;
            })
          ) {
            return summary;
          }
          await new Promise<void>((resolve) => {
            window.setTimeout(resolve, 50);
          });
        }
        const restartDetail = restartFailure instanceof Error
          ? ` (${restartFailure.message})`
          : "";
        throw new Error(
          "OpenClaw Gateway did not activate the model capability after "
          + `its safe restart${restartDetail}`
        );
      };

      const respond = (
        requestId: string,
        ok: boolean,
        payload: { error?: string; result?: unknown },
        type = "clawsembly:wizard-rpc-response"
      ) => {
        window.parent.postMessage({
          type,
          requestId,
          ok,
          ...payload
        }, location.origin);
      };
      window.addEventListener("message", (event: MessageEvent<unknown>) => {
        if (
          event.origin !== location.origin
          || event.source !== window.parent
        ) {
          return;
        }
        const rpc = isOnboardingRpcRequest(event.data)
          ? event.data
          : undefined;
        const capabilityRequest = consumeCapabilityRequest(event.data);
        const capabilityConfigRequest =
          isCapabilityConfigRequest(event.data)
            ? event.data
            : undefined;
        if (!rpc && !capabilityRequest && !capabilityConfigRequest) {
          return;
        }
        operationQueue = operationQueue.then(async () => {
          if (capabilityRequest) {
            try {
              runtimeSecrets.push(capabilityRequest.capability.apiKey);
              await attachByokCapability(capabilityRequest.capability);
              respond(
                capabilityRequest.requestId,
                true,
                { result: { status: "attached" } },
                "clawsembly:wizard-capability-response"
              );
            } catch (error) {
              respond(
                capabilityRequest.requestId,
                false,
                {
                  error: redactSensitiveValues(
                    error instanceof Error ? error.message : String(error),
                    runtimeSecrets
                  )
                },
                "clawsembly:wizard-capability-response"
              );
            }
            return;
          }
          if (capabilityConfigRequest) {
            try {
              const summary = await configureOpenClawCapability();
              respond(
                capabilityConfigRequest.requestId,
                true,
                { result: summary },
                "clawsembly:wizard-capability-config-response"
              );
            } catch (error) {
              respond(
                capabilityConfigRequest.requestId,
                false,
                {
                  error: redactSensitiveValues(
                    error instanceof Error
                      ? error.message
                      : String(error),
                    runtimeSecrets
                  )
                },
                "clawsembly:wizard-capability-config-response"
              );
            }
            return;
          }
          try {
            const rpcResult = await runGatewayRpc(rpc!.method, rpc!.params);
            respond(rpc!.requestId, true, {
              result: JSON.parse(JSON.stringify(rpcResult))
            });
          } catch (error) {
            respond(rpc!.requestId, false, {
              error: redactSensitiveValues(
                error instanceof Error
                  ? `${error.message}\n${error.stack ?? ""}`
                  : String(error),
                runtimeSecrets
              )
            });
          }
        }).catch((error) => {
          console.error("Clawsembly onboarding operation failed", error);
        });
      });
      status.dataset.state = "pass";
      status.textContent = "READY · Official OpenClaw Wizard connected";
      window.parent.postMessage({
        type: "clawsembly:wizard-gateway-ready",
        openclawVersion: packageMetadata.version,
        bootMode,
        bootCache: bootMode === "warm"
          ? "restored"
          : bootSnapshot
            ? "saved"
            : "unavailable",
        bootCacheFallback: warmBootFallback !== undefined,
        bootCacheWriteFailed: bootSnapshotError !== undefined
      }, location.origin);
      return;
    }
    status.textContent = agentTurnProof
      ? byokModelProof
        ? "Gateway ready; starting the user-authorized BYOK model turn…"
        : selfHostedModelProof
          ? "Gateway ready; starting a self-hosted OSS model turn…"
          : workspaceToolProof
            ? "Gateway ready; starting an OpenClaw workspace tool turn…"
            : "Gateway ready; starting an official OpenClaw agent turn…"
      : "Gateway ready; starting the official OpenClaw health client…";
    const clientArgs = agentTurnProof
      ? [
          "/openclaw/dist/entry.js",
          "agent",
          "--agent",
          "main",
          "--message",
          agentTurnPrompt,
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
    const clientProofTimeoutMs = agentTurnProof
      ? Math.min(150_000, proofTimeoutMs)
      // A restored Gateway proof starts a second WASIX VM after package
      // verification, OPFS restore, and Gateway bootstrap. GitHub-hosted
      // runners can leave that client unscheduled for longer than the
      // standalone health proof even though the Gateway remains healthy.
      : Math.min(180_000, proofTimeoutMs);
    const runClientAttempt = async (attempt: number) => {
      const clientStateRoot =
        `/openclaw/.clawsembly-client-state-${attempt}`;
      const clientInstance = await runWasix(moduleWithBytes, {
        program: "edgejs",
        args: clientArgs,
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
              ? workspaceToolProof
                ? isCompletedWorkspaceToolTurnResponse(
                    parsedOutput,
                    agentTurnMarker
                  )
                : isCompletedAgentTurnResponse(parsedOutput, agentTurnMarker)
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
        ? workspaceToolProof
          ? isCompletedWorkspaceToolTurnResponse(
              attemptResponse,
              agentTurnMarker
            )
          : isCompletedAgentTurnResponse(attemptResponse, agentTurnMarker)
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
    let workspaceTool:
      | {
          allowedTools: string[];
          commit: Awaited<ReturnType<
            typeof commitDirectoryTreeToOpfs
          >>;
          file: {
            bytes: number;
            expectedContent: string;
            path: string;
            restoredContentMatches: true;
            sha256: string;
          };
          outsideWorkspace: {
            attemptedPath: string;
            existsAfterTurn: false;
            policy: "workspace-only";
          };
          restore: Awaited<ReturnType<
            typeof restoreDirectoryTreeFromOpfs
          >>;
        }
      | undefined;
    if (proofPassed && workspaceToolProof) {
      const workspaceBytes = new Uint8Array(
        await gatewayOpenclaw.readFile(workspaceMountedFile)
      );
      const workspaceText = new TextDecoder().decode(workspaceBytes);
      if (workspaceText.trim() !== workspacePersistedContent) {
        throw new Error(
          "OpenClaw workspace tool wrote unexpected proof content"
        );
      }
      let outsideWorkspaceExists = false;
      try {
        await gatewayOpenclaw.readFile(workspaceOutsideFile);
        outsideWorkspaceExists = true;
      } catch {
        // A workspace-only tool call must not create this file.
      }
      if (outsideWorkspaceExists) {
        throw new Error(
          "OpenClaw workspace-only policy allowed an out-of-workspace write"
        );
      }
      status.textContent =
        "Tool turn complete; committing workspace to OPFS…";
      const commit = await commitDirectoryTreeToOpfs({
        directory: gatewayOpenclaw,
        rootPath: workspaceMountedRoot,
        storeId: workspaceStoreId
      });
      const restoredDirectory = new Directory();
      const restore = await restoreDirectoryTreeFromOpfs({
        directory: restoredDirectory,
        rootPath: workspaceMountedRoot,
        storeId: workspaceStoreId
      });
      const restoredBytes = new Uint8Array(
        await restoredDirectory.readFile(workspaceMountedFile)
      );
      const restoredText = new TextDecoder().decode(restoredBytes);
      if (restoredText !== workspaceText) {
        throw new Error("Restored OpenClaw workspace content mismatch");
      }
      workspaceTool = {
        allowedTools: workspaceAllowedTools,
        file: {
          bytes: workspaceBytes.byteLength,
          expectedContent: workspacePersistedContent,
          path: `${gatewayWorkspace}/${workspaceRelativeFile}`,
          restoredContentMatches: true,
          sha256: await sha256(workspaceBytes)
        },
        outsideWorkspace: {
          attemptedPath: `/openclaw${workspaceOutsideFile}`,
          existsAfterTurn: false,
          policy: "workspace-only"
        },
        commit,
        restore
      };
    }
    const evidence = {
      schemaVersion: 1,
      status: proofPassed
        ? agentTurnProof
          ? byokModelProof
            ? "byok-agent-turn-pass"
            : selfHostedModelProof
              ? "self-hosted-agent-turn-pass"
              : workspaceToolProof
                ? "workspace-tool-turn-pass"
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
          ? byokModelProof
            ? "A second browser guest executed the exact official OpenClaw "
              + "CLI and completed a real user-authorized model turn through "
              + "a browser-local fixed HTTP bridge. Only an opaque, bounded "
              + "capability entered OpenClaw; the provider credential stayed "
              + "in the expiring Cloudflare broker session."
            : selfHostedModelProof
              ? "A second browser guest executed the exact official OpenClaw "
              + "CLI, submitted a real agent turn through the unmodified "
              + "Gateway, and received an actual Qwen response from a pinned "
              + "self-hosted llama.cpp process while only an opaque operation "
              + "capability entered the browser."
            : workspaceToolProof
              ? "The unmodified OpenClaw Gateway executed real write and read "
                + "tools inside a workspace-only browser filesystem, rejected "
                + "an out-of-workspace write, and recovered the committed "
                + "workspace from OPFS into a fresh guest Directory."
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
      ...(workspaceTool ? { workspaceTool } : {}),
      network: networkEvidence,
      isolation: isolationEvidence,
      launchHarness: launchHarnessEvidence,
      ...(agentTurnProof
        ? {
            agentResponseValidation: {
              contract: workspaceToolProof
                ? "workspace-tool-payload-v1"
                : "strict-assistant-payload-v1",
              expectedText: agentTurnMarker,
              acceptedTextSources: [
                "result.payloads[].text",
                "result.meta.finalAssistantVisibleText",
                "result.meta.finalAssistantRawText"
              ],
              requiredOutcome: workspaceToolProof
                ? "status=ok; summary=completed; aborted=false; "
                  + "stopReason=stop; fallbackUsed=false; assistant-stage "
                  + "success; exactly three tool calls; one denied outside "
                  + "write; exact final marker"
                : "status=ok; summary=completed; aborted=false; "
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
      ...(proofKind === "agent-turn" || workspaceToolProof
        ? {
            providerFixture: {
              api: "openai-completions",
              baseUrl: providerBaseUrl,
              expectedMarker: agentTurnMarker,
              model: `${providerName}/${providerModel}`,
              mode: workspaceToolProof
                ? "write-read-outside-rejection"
                : "assistant-response"
            }
          }
        : {}),
      ...(selfHostedModelProof
        ? {
            selfHostedModel: {
              api: "openai-completions",
              browserReceivesModelServiceCredential: false,
              guestEndpoint: providerBaseUrl,
              guestOperationCapability: {
                authority:
                  `POST ${providerBaseUrl}/chat/completions`,
                model: providerModel,
                recorded: false,
                revocable: true,
                streamingRequired: true,
                ttlSeconds: 300
              },
              expectedMarker: agentTurnMarker,
              generation: {
                temperature: selfHostedModelTemperature
              },
              proofAgentPolicy: {
                allowedTools: [],
                deny: selfHostedModelToolDeny,
                rationale:
                  "This response-only proof grants no tool authority, keeping "
                  + "the model prompt and capability surface minimal without "
                  + "modifying the OpenClaw package."
              },
              model: `${providerName}/${providerModel}`,
              runtime: {
                implementation: "llama.cpp",
                license: "MIT",
                release: "b9637",
                sourceCommit:
                  "aedb2a5e9ca3d4064148bbb919e0ddc0c1b70ab3",
                distribution: {
                  platform: "ubuntu-x64",
                  sha256:
                    "a50ee14f021a9d8e92e30f622f7e3be1318ee1125bb9a9ba8d2025388df48743",
                  url:
                    "https://github.com/ggml-org/llama.cpp/releases/download/"
                    + "b9637/llama-b9637-bin-ubuntu-x64.tar.gz"
                },
                endpoint:
                  "http://127.0.0.1:18795/v1/chat/completions",
                loopbackOnly: true,
                model: {
                  id: providerModel,
                  license: "Apache-2.0",
                  repository:
                    "Qwen/Qwen2.5-0.5B-Instruct-GGUF",
                  revision:
                    "d78c9c2baefc6237025b685bb0d6db90288ef3d6",
                  file:
                    "qwen2.5-0.5b-instruct-q4_k_m.gguf",
                  sha256:
                    "74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db"
                },
                authentication: {
                  credential: "host-local llama.cpp API key",
                  recorded: false,
                  visibleToGuest: false
                },
                transport:
                  "explicitly allowed host-loopback HTTP; no external network"
              },
              capabilityBroker: {
                implementation: "clawsembly-provider-broker",
                security: {
                  capabilityTtlSeconds: 300,
                  exactEndpointAndModel: true,
                  hostOnlyRevocation: true,
                  loopbackOnly: true,
                  maxConcurrency: 1,
                  maxRequestBytes: 2_097_152,
                  maxRequests: 1,
                  maxResponseBytes: 2_097_152,
                  revocationPath: "/v1/capability/revoke",
                  redirects: "disabled",
                  systemProxy: "disabled"
                }
              }
            }
          }
        : {}),
      ...(byokModelProof
        ? {
            byokModel: {
              api: byokModelCapability?.modelApi,
              expectedMarker: agentTurnMarker,
              guestEndpoint: providerBaseUrl,
              guestReceivesProviderCredential: false,
              model: `${providerName}/${providerModel}`,
              operationCapability: {
                authority:
                  `POST ${byokModelCapability?.baseUrl}${
                    byokModelCapability?.apiPath.slice("/v1".length)
                  }`,
                expiresAt: byokModelCapability?.expiresAt,
                model: providerModel,
                recorded: false,
                revocable: true
              },
              proofAgentPolicy: {
                allowedTools: [],
                deny: selfHostedModelToolDeny
              },
              hostBridge: {
                implementation:
                  "browser fetch + capability-directory mailbox + "
                  + "browser-local Edge.js HTTP loopback",
                loopbackEndpoint: providerBaseUrl,
                stats: byokHttpBridge?.snapshot(),
                guest: byokBridgeGuest
                  ? {
                      stdout: byokBridgeGuest.stdout.snapshot(),
                      stderr: byokBridgeGuest.stderr.snapshot()
                    }
                  : undefined
              },
              broker: {
                implementation:
                  "Cloudflare Worker + unique Durable Object session",
                exactProviderAndModel: true,
                maxRequestBytes: 2_097_152,
                providerCredentialRecorded: false,
                providerCredentialVisibleToGuest: false,
                revocable: true
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
        ? byokModelProof
          ? "PASS · OpenClaw completed a user-authorized BYOK turn"
          : selfHostedModelProof
            ? "PASS · Unmodified OpenClaw completed a self-hosted model turn"
            : workspaceToolProof
              ? "PASS · OpenClaw workspace tools persisted and restored"
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
