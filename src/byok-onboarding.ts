import "./byok-onboarding.css";
import {
  clearByokCapabilityHandoff,
  stageByokCapabilityHandoff
} from "./byok-capability-handoff";

type Capability = {
  adminToken: string;
  baseUrl: string;
  expiresAt: string;
  maxRequests: number;
  model: string;
  provider: string;
  providerId: string;
  providerLabel: string;
  token: string;
};

type CapabilityResponse = {
  schemaVersion: 1;
  status: "ready";
  capability: Capability;
};

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

const form = requiredElement<HTMLFormElement>("#byok-form");
const provider = requiredElement<HTMLSelectElement>("#byok-provider");
const model = requiredElement<HTMLInputElement>("#byok-model");
const apiKey = requiredElement<HTMLInputElement>("#byok-key");
const connectButton =
  requiredElement<HTMLButtonElement>("#byok-connect");
const testButton = requiredElement<HTMLButtonElement>("#byok-test");
const launchButton = requiredElement<HTMLButtonElement>("#byok-launch");
const revokeButton = requiredElement<HTMLButtonElement>("#byok-revoke");
const status = requiredElement<HTMLOutputElement>("#byok-status");
const sessionPanel = requiredElement<HTMLElement>(".byok-session");
const expiry = requiredElement<HTMLElement>("#byok-expiry");
const budget = requiredElement<HTMLElement>("#byok-budget");
const testResult = requiredElement<HTMLElement>("#byok-test-result");
const runtimePanel = requiredElement<HTMLElement>(".byok-runtime");
const runtimeFrame =
  requiredElement<HTMLIFrameElement>("#byok-runtime-frame");
const steps = Array.from(document.querySelectorAll<HTMLElement>(
  "aside li"
));

let capability: Capability | undefined;
let capabilityVerified = false;

function setStatus(
  state: "idle" | "running" | "ready" | "fail",
  label: string
): void {
  status.dataset.state = state;
  status.replaceChildren();
  const dot = document.createElement("span");
  dot.setAttribute("aria-hidden", "true");
  status.append(dot, document.createTextNode(label));
}

function setStep(activeIndex: number): void {
  steps.forEach((step, index) => {
    step.dataset.stepState = index < activeIndex
      ? "complete"
      : index === activeIndex
        ? "active"
        : "pending";
  });
}

function setBusy(busy: boolean): void {
  connectButton.disabled = busy || capability !== undefined;
  provider.disabled = busy || capability !== undefined;
  model.disabled = busy || capability !== undefined;
  apiKey.disabled = busy || capability !== undefined;
  testButton.disabled = busy || capability === undefined;
  launchButton.disabled =
    busy || capability === undefined || !capabilityVerified;
  revokeButton.disabled = busy || capability === undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "接続を準備できませんでした";
}

async function issueCapability(): Promise<void> {
  setBusy(true);
  setStatus("running", "接続を作成中");
  testResult.textContent = "";
  try {
    const response = await fetch("/api/byok/capabilities", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        provider: provider.value,
        model: model.value.trim(),
        apiKey: apiKey.value
      })
    });
    apiKey.value = "";
    const body = await response.json() as CapabilityResponse & {
      error?: { code?: string };
    };
    if (!response.ok || body.status !== "ready") {
      throw new Error(body.error?.code ?? `HTTP ${response.status}`);
    }
    capability = body.capability;
    capabilityVerified = false;
    stageByokCapabilityHandoff({
      apiKey: capability.token,
      baseUrl: capability.baseUrl,
      expiresAt: capability.expiresAt,
      model: capability.model,
      providerId: "clawsembly-byok"
    });
    expiry.textContent = new Intl.DateTimeFormat("ja-JP", {
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date(capability.expiresAt)) + "まで";
    budget.textContent = `最大${capability.maxRequests}リクエスト`;
    sessionPanel.hidden = false;
    setStep(1);
    setStatus("ready", `${capability.providerLabel} 接続済み`);
  } catch (error) {
    apiKey.value = "";
    setStatus("fail", "接続失敗");
    testResult.textContent = errorMessage(error);
  } finally {
    setBusy(false);
  }
}

async function testCapability(): Promise<void> {
  if (!capability) return;
  setBusy(true);
  setStatus("running", "モデルを確認中");
  testResult.textContent = "モデルへ最小の確認リクエストを送信しています…";
  try {
    const response = await fetch(`${capability.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${capability.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: capability.model,
        messages: [{
          role: "user",
          content: "Reply with exactly READY"
        }],
        stream: false,
        max_completion_tokens: 12
      })
    });
    const body = await response.json() as {
      choices?: Array<{
        message?: { content?: string };
      }>;
      error?: { code?: string; message?: string };
    };
    if (!response.ok) {
      throw new Error(
        body.error?.message
        ?? body.error?.code
        ?? `HTTP ${response.status}`
      );
    }
    const reply = body.choices?.[0]?.message?.content?.trim();
    if (!reply) throw new Error("モデルから応答がありませんでした");
    capabilityVerified = true;
    testResult.textContent = `接続確認済み · ${reply}`;
    setStep(1);
    setStatus("ready", "OpenClawへ接続可能");
  } catch (error) {
    testResult.textContent = errorMessage(error);
    setStatus("fail", "モデル確認失敗");
  } finally {
    setBusy(false);
  }
}

async function revokeCapability(): Promise<void> {
  if (!capability) return;
  const activeCapability = capability;
  capability = undefined;
  capabilityVerified = false;
  clearByokCapabilityHandoff();
  setBusy(true);
  setStatus("running", "接続を破棄中");
  try {
    const response = await fetch("/api/byok/capabilities/revoke", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${activeCapability.adminToken}`
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    sessionPanel.hidden = true;
    runtimePanel.hidden = true;
    runtimeFrame.removeAttribute("src");
    testResult.textContent = "";
    setStep(0);
    setStatus("idle", "破棄済み");
  } catch (error) {
    testResult.textContent = errorMessage(error);
    setStatus("fail", "破棄確認失敗");
  } finally {
    setBusy(false);
  }
}

function launchOpenClaw(): void {
  if (!capability || !capabilityVerified) return;
  runtimePanel.hidden = false;
  setStep(2);
  setStatus("running", "OpenClawを起動中");
  runtimeFrame.src = "/byok-runtime.html?proof=byok-agent-turn";
  runtimePanel.scrollIntoView({
    behavior: "smooth",
    block: "start"
  });
}

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (
    event.origin !== location.origin
    || event.source !== runtimeFrame.contentWindow
    || !event.data
    || typeof event.data !== "object"
  ) {
    return;
  }
  const message = event.data as {
    label?: unknown;
    state?: unknown;
    type?: unknown;
  };
  if (message.type === "clawsembly:byok-runtime-status") {
    const state = message.state === "pass"
      ? "ready"
      : message.state === "fail"
        ? "fail"
        : "running";
    setStatus(
      state,
      typeof message.label === "string"
        ? message.label
        : "OpenClawを起動中"
    );
    return;
  }
  if (
    message.type !== "clawsembly:byok-runtime-ready"
    || !capability
  ) {
    return;
  }
  runtimeFrame.contentWindow?.postMessage({
    type: "clawsembly:byok-runtime-start",
    capability: {
      apiKey: capability.token,
      baseUrl: capability.baseUrl,
      expiresAt: capability.expiresAt,
      model: capability.model,
      providerId: "clawsembly-byok"
    }
  }, location.origin);
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void issueCapability();
});
testButton.addEventListener("click", () => {
  void testCapability();
});
launchButton.addEventListener("click", launchOpenClaw);
revokeButton.addEventListener("click", () => {
  void revokeCapability();
});

window.addEventListener("pagehide", () => {
  if (!capability) return;
  void fetch("/api/byok/capabilities/revoke", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${capability.adminToken}`
    },
    keepalive: true
  });
  capability = undefined;
  capabilityVerified = false;
  clearByokCapabilityHandoff();
});

setStep(0);
setBusy(false);
