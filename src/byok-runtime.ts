import "./style.css";
import {
  isSecureByokBaseUrl,
  stageByokCapabilityHandoff,
  type ByokCapabilityHandoff
} from "./byok-capability-handoff";
import type {
  OpenClawRuntimeHost
} from "./openclaw-runtime-host";
import { readSharedRuntimeEpoch } from "./openclaw-runtime-recovery";

type RuntimeStartMessage = {
  capability: ByokCapabilityHandoff;
  type: "clawsembly:byok-runtime-start";
} | {
  type: "clawsembly:onboarding-runtime-start";
};

type RuntimeOperationMessage = {
  requestId: string;
  type:
    | "clawsembly:wizard-capability-attach"
    | "clawsembly:wizard-capability-configure"
    | "clawsembly:wizard-rpc-request";
};

function isRuntimeStartMessage(value: unknown): value is RuntimeStartMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const message = value as Partial<RuntimeStartMessage>;
  if (message.type === "clawsembly:onboarding-runtime-start") {
    return true;
  }
  if (message.type !== "clawsembly:byok-runtime-start") return false;
  const capability = message.capability;
  return Boolean(capability)
    && capability?.providerId === "clawsembly-byok"
    && typeof capability.apiKey === "string"
    && capability.apiKey.length > 0
    && (
      capability.apiPath === "/v1/chat/completions"
      || capability.apiPath === "/v1/responses"
    )
    && typeof capability.baseUrl === "string"
    && isSecureByokBaseUrl(capability.baseUrl)
    && typeof capability.expiresAt === "string"
    && (
      capability.modelApi === "openai-completions"
      || capability.modelApi === "openai-chatgpt-responses"
    )
    && typeof capability.model === "string"
    && capability.model.length > 0
    && (
      capability.openClawProvider === "clawsembly-byok"
      || capability.openClawProvider === "openai"
    );
}

function isRuntimeOperationMessage(
  value: unknown
): value is RuntimeOperationMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const message = value as Partial<RuntimeOperationMessage>;
  return typeof message.requestId === "string"
    && /^[A-Za-z0-9_-]{1,128}$/u.test(message.requestId)
    && (
      message.type === "clawsembly:wizard-capability-attach"
      || message.type === "clawsembly:wizard-capability-configure"
      || message.type === "clawsembly:wizard-rpc-request"
    );
}

let started = false;
const runtimeStatus = document.querySelector<HTMLOutputElement>("#status");
const runtimeResult = document.querySelector<HTMLPreElement>("#result");
const bootstrapLockName = "clawsembly-openclaw-bootstrap-v1";
// A SharedWorker can outlive the page that created it. Include both an explicit
// compatibility generation and this runtime chunk's content-hashed URL so a
// newly deployed bridge never reconnects to an older in-memory owner.
const sharedRuntimeName =
  `clawsembly-openclaw-runtime-v3:${readSharedRuntimeEpoch()}:${import.meta.url}`;
const onboardingSharedRuntime =
  new URLSearchParams(location.search).get("proof") === "onboarding"
  && typeof SharedWorker === "function";
let sharedRuntimePort: MessagePort | undefined;
let sharedRuntimeOwner = false;
let sharedOwnerStarted = false;
let sharedOwnerMessageListener: ((data: unknown) => void) | undefined;

if (runtimeStatus && !onboardingSharedRuntime) {
  new MutationObserver(() => {
    window.parent.postMessage({
      type: "clawsembly:byok-runtime-status",
      state: runtimeStatus.dataset.state ?? "running",
      label: runtimeStatus.textContent?.trim() ?? ""
    }, location.origin);
  }).observe(runtimeStatus, {
    attributes: true,
    childList: true,
    subtree: true
  });
}

function sendSharedOwnerOutput(message: unknown): void {
  sharedRuntimePort?.postMessage({
    type: "clawsembly:shared-runtime-owner-output",
    message
  });
}

function installSharedOwnerHost(): void {
  if (!runtimeStatus || !runtimeResult) return;
  const runtimeHost: OpenClawRuntimeHost = {
    origin: location.origin,
    search: "?proof=onboarding",
    status: {
      dataset: runtimeStatus.dataset,
      get textContent() {
        return runtimeStatus.textContent;
      },
      set textContent(value: string | null) {
        runtimeStatus.textContent = value;
        sendSharedOwnerOutput({
          type: "clawsembly:byok-runtime-status",
          state: runtimeStatus.dataset.state ?? "running",
          label: value?.trim() ?? ""
        });
      }
    },
    result: {
      get textContent() {
        return runtimeResult.textContent;
      },
      set textContent(value: string | null) {
        runtimeResult.textContent = value;
        sendSharedOwnerOutput({
          type: "clawsembly:shared-runtime-result",
          text: value ?? ""
        });
      }
    },
    addMessageListener(listener) {
      sharedOwnerMessageListener = listener;
    },
    postMessage(message) {
      sendSharedOwnerOutput(message);
    }
  };
  globalThis.__clawsemblyOpenClawRuntimeHost = runtimeHost;
}

function startSharedOwner(): void {
  if (!sharedRuntimeOwner || sharedOwnerStarted) return;
  sharedOwnerStarted = true;
  installSharedOwnerHost();
  void startRuntimeProbe();
}

if (onboardingSharedRuntime) {
  try {
    const sharedRuntime = new SharedWorker(
      new URL("./openclaw-shared-worker.ts", import.meta.url),
      {
        name: sharedRuntimeName,
        type: "module"
      }
    );
    sharedRuntimePort = sharedRuntime.port;
    sharedRuntimePort.onmessage = (event: MessageEvent<unknown>) => {
      const message = event.data as {
        label?: unknown;
        message?: unknown;
        state?: unknown;
        text?: unknown;
        type?: unknown;
      };
      if (message.type === "clawsembly:shared-runtime-owner") {
        sharedRuntimeOwner = true;
        installSharedOwnerHost();
        return;
      }
      if (message.type === "clawsembly:shared-runtime-follower") {
        sharedRuntimeOwner = false;
        return;
      }
      if (message.type === "clawsembly:shared-runtime-owner-start") {
        startSharedOwner();
        return;
      }
      if (message.type === "clawsembly:shared-runtime-owner-input") {
        sharedOwnerMessageListener?.(message.message);
        return;
      }
      if (message.type === "clawsembly:byok-runtime-status") {
        if (runtimeStatus) {
          runtimeStatus.dataset.state = typeof message.state === "string"
            ? message.state
            : "running";
          runtimeStatus.textContent = typeof message.label === "string"
            ? message.label
            : "Shared OpenClaw runtime is starting…";
        }
        window.parent.postMessage(event.data, location.origin);
        return;
      }
      if (message.type === "clawsembly:shared-runtime-result") {
        if (runtimeResult) {
          runtimeResult.textContent = typeof message.text === "string"
            ? message.text
            : "";
        }
        return;
      }
      window.parent.postMessage(event.data, location.origin);
    };
    sharedRuntimePort.start();
    window.addEventListener("pagehide", () => {
      sharedRuntimePort?.postMessage({
        type: "clawsembly:shared-runtime-disconnect"
      });
    }, { once: true });
  } catch (error) {
    sharedRuntimePort = undefined;
    console.warn("Shared OpenClaw runtime is unavailable", error);
  }
}

function waitForBootTerminal(): Promise<void> {
  if (
    !runtimeStatus
    || runtimeStatus.dataset.state === "pass"
    || runtimeStatus.dataset.state === "fail"
  ) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (
        runtimeStatus.dataset.state !== "pass"
        && runtimeStatus.dataset.state !== "fail"
      ) {
        return;
      }
      observer.disconnect();
      resolve();
    });
    observer.observe(runtimeStatus, {
      attributes: true,
      childList: true,
      subtree: true
    });
  });
}

async function startRuntimeProbe(): Promise<void> {
  try {
    await import("./openclaw-gateway-health-probe");
    await waitForBootTerminal();
  } catch (error) {
    if (runtimeStatus) {
      runtimeStatus.dataset.state = "fail";
      runtimeStatus.textContent = "FAIL";
    }
    console.error("Clawsembly runtime bootstrap failed", error);
  }
}

async function startRuntimeWithBootstrapLock(): Promise<void> {
  if (!navigator.locks) {
    await startRuntimeProbe();
    return;
  }
  const startedImmediately = await navigator.locks.request(
    bootstrapLockName,
    { ifAvailable: true, mode: "exclusive" },
    async (lock) => {
      if (!lock) return false;
      await startRuntimeProbe();
      return true;
    }
  );
  if (startedImmediately) return;
  if (runtimeStatus) {
    runtimeStatus.dataset.state = "running";
    runtimeStatus.textContent =
      "Waiting for another Clawsembly tab to finish starting OpenClaw…";
  }
  await navigator.locks.request(
    bootstrapLockName,
    { mode: "exclusive" },
    async () => {
      if (runtimeStatus) {
        runtimeStatus.textContent =
          "The other tab finished; restoring OpenClaw boot state…";
      }
      await startRuntimeProbe();
    }
  );
}

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (
    event.origin !== location.origin
    || event.source !== window.parent
  ) {
    return;
  }
  if (sharedRuntimePort && isRuntimeOperationMessage(event.data)) {
    sharedRuntimePort.postMessage(event.data);
    return;
  }
  if (started || !isRuntimeStartMessage(event.data)) return;
  started = true;
  if (sharedRuntimePort) {
    sharedRuntimePort.postMessage(event.data);
    return;
  }
  if (event.data.type === "clawsembly:byok-runtime-start") {
    stageByokCapabilityHandoff(event.data.capability);
  }
  void startRuntimeWithBootstrapLock();
});

window.parent.postMessage(
  { type: "clawsembly:byok-runtime-ready" },
  location.origin
);
