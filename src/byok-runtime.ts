import "./style.css";
import {
  isSecureByokBaseUrl,
  stageByokCapabilityHandoff,
  type ByokCapabilityHandoff
} from "./byok-capability-handoff";

type RuntimeStartMessage = {
  capability: ByokCapabilityHandoff;
  type: "clawsembly:byok-runtime-start";
} | {
  type: "clawsembly:onboarding-runtime-start";
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

let started = false;
const runtimeStatus = document.querySelector<HTMLOutputElement>("#status");
if (runtimeStatus) {
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
window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (
    started
    || event.origin !== location.origin
    || event.source !== window.parent
    || !isRuntimeStartMessage(event.data)
  ) {
    return;
  }
  started = true;
  if (event.data.type === "clawsembly:byok-runtime-start") {
    stageByokCapabilityHandoff(event.data.capability);
  }
  void import("./openclaw-gateway-health-probe");
});

window.parent.postMessage(
  { type: "clawsembly:byok-runtime-ready" },
  location.origin
);
