import "./byok-onboarding.css";
import { rotateSharedRuntimeEpoch } from "./openclaw-runtime-recovery";

type Capability = {
  adminToken: string;
  apiPath: "/v1/chat/completions" | "/v1/responses";
  baseUrl: string;
  expiresAt: string;
  maxRequests: number;
  model: string;
  modelApi: "openai-completions" | "openai-chatgpt-responses";
  openClawProvider: "clawsembly-byok" | "openai";
  provider: string;
  providerId: "clawsembly-byok";
  providerLabel: string;
  token: string;
};

type WizardOption = {
  hint?: string;
  label: string;
  value: string;
};

type WizardStep = {
  executor?: "client" | "gateway";
  format?: "plain";
  id: string;
  initialValue?: unknown;
  message?: string;
  options?: WizardOption[];
  placeholder?: string;
  sensitive?: boolean;
  title?: string;
  type:
    | "action"
    | "confirm"
    | "multiselect"
    | "note"
    | "progress"
    | "select"
    | "text";
};

type WizardResult = {
  done: boolean;
  error?: string;
  sessionId?: string;
  status?: "cancelled" | "done" | "error" | "running";
  step?: WizardStep;
};

type DeviceStartResponse = {
  adminToken: string;
  authorization: {
    expiresAt: string;
    intervalMs: number;
    userCode: string;
    verificationUrl: string;
  };
  pollToken: string;
  pollUrl: string;
  schemaVersion: 1;
  status: "authorization_pending";
};

type RpcResponse = {
  error?: string;
  ok: boolean;
  requestId: string;
  result?: unknown;
  type:
    | "clawsembly:wizard-capability-response"
    | "clawsembly:wizard-capability-config-response"
    | "clawsembly:wizard-rpc-response";
};

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

const status = requiredElement<HTMLOutputElement>("#byok-status");
const steps = Array.from(
  document.querySelectorAll<HTMLElement>("aside li")
);
const wizardOrigin = requiredElement<HTMLElement>("#wizard-origin");
const wizardTitle = requiredElement<HTMLElement>("#wizard-title");
const wizardMessage = requiredElement<HTMLElement>("#wizard-message");
const wizardError = requiredElement<HTMLElement>("#wizard-error");
const wizardControls = requiredElement<HTMLElement>("#wizard-controls");
const wizardStage = requiredElement<HTMLElement>(".wizard-stage");
const credentialAdapter =
  requiredElement<HTMLElement>("#credential-adapter");
const credentialMethods =
  requiredElement<HTMLElement>("#credential-methods");
const oauthStart = requiredElement<HTMLButtonElement>("#oauth-start");
const apiKeyShow = requiredElement<HTMLButtonElement>("#api-key-show");
const oauthPanel = requiredElement<HTMLElement>("#oauth-panel");
const oauthVerifyLink =
  requiredElement<HTMLAnchorElement>("#oauth-verify-link");
const oauthCode = requiredElement<HTMLElement>("#oauth-code");
const oauthCopy = requiredElement<HTMLButtonElement>("#oauth-copy");
const oauthCopyLabel = requiredElement<HTMLElement>("#oauth-copy-label");
const oauthCopyFeedback =
  requiredElement<HTMLElement>("#oauth-copy-feedback");
const oauthExpires = requiredElement<HTMLElement>("#oauth-expires");
const oauthStatus = requiredElement<HTMLElement>("#oauth-status");
const oauthBack = requiredElement<HTMLButtonElement>("#oauth-back");
const oauthSteps = Array.from(
  document.querySelectorAll<HTMLElement>("[data-oauth-step]")
);
const apiKeyPanel = requiredElement<HTMLFormElement>("#api-key-panel");
const apiKeyBack = requiredElement<HTMLButtonElement>("#api-key-back");
const provider = requiredElement<HTMLSelectElement>("#byok-provider");
const model = requiredElement<HTMLInputElement>("#byok-model");
const apiKey = requiredElement<HTMLInputElement>("#byok-key");
const connectButton =
  requiredElement<HTMLButtonElement>("#byok-connect");
const expiry = requiredElement<HTMLElement>("#byok-expiry");
const budget = requiredElement<HTMLElement>("#byok-budget");
const credentialResult =
  requiredElement<HTMLElement>("#credential-result");
const credentialResume =
  requiredElement<HTMLElement>("#credential-resume");
const credentialResumeButton =
  requiredElement<HTMLButtonElement>("#credential-resume-button");
const runtimePanel = requiredElement<HTMLElement>(".byok-runtime");
const runtimeTitle = requiredElement<HTMLElement>("#runtime-title");
const runtimeSummary = requiredElement<HTMLElement>("#runtime-summary");
const runtimeFrame =
  requiredElement<HTMLIFrameElement>("#byok-runtime-frame");
const revokeButton = requiredElement<HTMLButtonElement>("#byok-revoke");
const bootProgress = requiredElement<HTMLElement>("#boot-progress");
const bootTitle = requiredElement<HTMLElement>("#boot-title");
const bootDetail = requiredElement<HTMLElement>("#boot-detail");
const bootElapsed = requiredElement<HTMLTimeElement>("#boot-elapsed");
const bootBar = requiredElement<HTMLElement>("#boot-bar");
const bootPatience = requiredElement<HTMLElement>("#boot-patience");
const bootRetry = requiredElement<HTMLButtonElement>("#boot-retry");
const bootPhases = Array.from(
  document.querySelectorAll<HTMLElement>("[data-boot-phase]")
);

const pendingRequests = new Map<string, {
  reject: (reason: Error) => void;
  resolve: (value: unknown) => void;
  timeout: number;
}>();

let wizardSessionId: string | undefined;
let currentStep: WizardStep | undefined;
let selectedProvider: "openai" | "openrouter" = "openai";
let capability: Capability | undefined;
let oauthAdminToken: string | undefined;
let oauthAttempt = 0;
let oauthCopyTimer: number | undefined;
let capabilityAttached = false;
let wizardStarted = false;
let finishing = false;
let runtimeHandshakeTimer: number | undefined;
let bootTimer: number | undefined;
let bootPhase = 0;
let bootStartedAt = performance.now();
let runtimeRecoveryAttempts = 0;
let runtimeRecoveryInProgress = false;
let initialChannelSkipInProgress = false;
const gatewayReconnectWindowMs = 30_000;
const initialChannelSkipTimeoutMs = 35_000;
const runtimeRequestTimeoutMs = 135_000;
const maximumAutomaticRuntimeRecoveries = 2;

function setStatus(
  state: "fail" | "idle" | "ready" | "running",
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

function setOauthStep(activeStep: "approve" | "copy"): void {
  const activeIndex = activeStep === "copy" ? 0 : 1;
  oauthSteps.forEach((step, index) => {
    step.dataset.state = index < activeIndex
      ? "complete"
      : index === activeIndex
        ? "active"
        : "pending";
  });
}

function resetOauthCopy(): void {
  if (oauthCopyTimer !== undefined) {
    window.clearTimeout(oauthCopyTimer);
    oauthCopyTimer = undefined;
  }
  oauthCode.textContent = "—";
  oauthCopy.disabled = true;
  oauthCopy.setAttribute("aria-label", "認証コードをコピー");
  oauthCopyLabel.textContent = "コピー";
  oauthCopyFeedback.textContent = "";
  oauthExpires.textContent = "コードを準備中";
  oauthVerifyLink.setAttribute("aria-disabled", "true");
  setOauthStep("copy");
}

function fallbackCopy(value: string): boolean {
  const field = document.createElement("textarea");
  field.value = value;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  const copied = document.execCommand("copy");
  field.remove();
  return copied;
}

async function copyOauthCode(): Promise<void> {
  const value = oauthCode.textContent?.trim() ?? "";
  if (!value || value === "—") return;
  try {
    let copied = false;
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value);
        copied = true;
      } catch {
        copied = false;
      }
    }
    if (!copied) copied = fallbackCopy(value);
    if (!copied) {
      throw new Error("clipboard unavailable");
    }
    oauthCopyLabel.textContent = "コピーしました ✓";
    oauthCopy.setAttribute(
      "aria-label",
      `認証コード ${value} をもう一度コピー`
    );
    oauthCopyFeedback.textContent =
      "コピーしました。OpenAIの入力欄へそのまま貼り付けられます。";
    setOauthStep("approve");
    if (oauthCopyTimer !== undefined) window.clearTimeout(oauthCopyTimer);
    oauthCopyTimer = window.setTimeout(() => {
      oauthCopyLabel.textContent = "もう一度コピー";
      oauthCopyTimer = undefined;
    }, 2_500);
  } catch {
    oauthCopyFeedback.textContent =
      "コピーできませんでした。コードを選択してコピーしてください。";
  }
}

function showCredentialMethods(): void {
  oauthAttempt += 1;
  const adminToken = oauthAdminToken;
  oauthAdminToken = undefined;
  credentialMethods.hidden = false;
  oauthPanel.hidden = true;
  apiKeyPanel.hidden = true;
  credentialResume.hidden = true;
  credentialResult.textContent = "";
  credentialResult.dataset.state = "idle";
  resetOauthCopy();
  setStatus("ready", "接続方法を選択");
  if (adminToken) {
    void fetch("/api/byok/capabilities/revoke", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` }
    }).catch(() => undefined);
  }
}

const bootCopy = [
  {
    status: "実行環境を読込中",
    title: "実行環境を読み込んでいます",
    detail: "初回のみ約385 MBを確認・読み込みます。通常は数分で完了します。"
  },
  {
    status: "OpenClawを検証中",
    title: "OpenClawを確認しています",
    detail: "ダウンロードした実行環境とパッケージが正しいことを確認しています。"
  },
  {
    status: "ブラウザ内へ展開中",
    title: "ブラウザ内へ展開しています",
    detail: "OpenClawのファイルと必要な状態を、安全なブラウザ環境へ展開しています。"
  },
  {
    status: "OpenClawを起動中",
    title: "OpenClawを起動しています",
    detail: "Gatewayと公式Wizardを接続しています。あと少しで設定を始められます。"
  }
] as const;

function elapsedLabel(): string {
  const elapsedSeconds = Math.max(
    0,
    Math.floor((performance.now() - bootStartedAt) / 1_000)
  );
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = String(elapsedSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function updateBootElapsed(): void {
  const elapsedSeconds = Math.max(
    0,
    Math.floor((performance.now() - bootStartedAt) / 1_000)
  );
  bootElapsed.textContent = `経過 ${elapsedLabel()}`;
  if (elapsedSeconds >= 20 && bootProgress.dataset.state === "running") {
    bootPatience.hidden = false;
  }
  if (elapsedSeconds >= 90 && bootProgress.dataset.state === "running") {
    bootPatience.textContent =
      "初回起動は回線や端末によって数分かかります。処理は継続中です。";
  }
}

function setBootPhase(nextPhase: number): void {
  bootPhase = Math.max(bootPhase, Math.min(3, Math.max(0, nextPhase)));
  const copy = bootCopy[bootPhase];
  bootProgress.dataset.state = "running";
  bootProgress.style.setProperty(
    "--boot-progress",
    `${[12, 38, 68, 88][bootPhase]}%`
  );
  bootBar.setAttribute(
    "aria-valuenow",
    String([12, 38, 68, 88][bootPhase])
  );
  bootTitle.textContent = copy.title;
  bootDetail.textContent = copy.detail;
  bootPhases.forEach((phase, index) => {
    phase.dataset.bootState = index < bootPhase
      ? "complete"
      : index === bootPhase
        ? "active"
        : "pending";
  });
  setStatus("running", copy.status);
}

function restartBootProgress(): void {
  if (bootTimer !== undefined) window.clearInterval(bootTimer);
  bootStartedAt = performance.now();
  bootPhase = 0;
  delete bootProgress.dataset.bootMode;
  delete bootProgress.dataset.bootTimings;
  bootPatience.hidden = true;
  bootPatience.textContent =
    "画面を閉じずにお待ちください。別のタブへ移動しても処理は続きます。";
  bootRetry.hidden = true;
  setBootPhase(0);
  updateBootElapsed();
  bootTimer = window.setInterval(updateBootElapsed, 1_000);
}

function phaseForRuntimeLabel(label: string): number {
  const normalized = label.toLowerCase();
  if (
    normalized.includes("starting the exact")
    || normalized.includes("gateway listening")
    || normalized.includes("persistent official")
  ) {
    return 3;
  }
  if (
    normalized.includes("installing")
    || normalized.includes("restoring")
    || normalized.includes("lifecycle")
  ) {
    return 2;
  }
  if (normalized.includes("verifying")) return 1;
  return 0;
}

function finishBoot(
  mode: "cold" | "shared" | "warm",
  timings?: Record<string, number>
): void {
  if (bootTimer !== undefined) {
    window.clearInterval(bootTimer);
    bootTimer = undefined;
  }
  const completedIn = elapsedLabel();
  bootProgress.dataset.state = "ready";
  bootProgress.dataset.bootMode = mode;
  if (timings) {
    bootProgress.dataset.bootTimings = JSON.stringify(timings);
  }
  bootProgress.style.setProperty("--boot-progress", "100%");
  bootBar.setAttribute("aria-valuenow", "100");
  bootTitle.textContent = mode === "shared"
    ? "実行中のOpenClawに接続しました"
    : mode === "warm"
      ? "OpenClawを復元しました"
      : "OpenClawを起動しました";
  bootDetail.textContent = mode === "shared"
    ? `${completedIn}で別タブの実行環境を再利用しました。公式Wizardを開いています。`
    : mode === "warm"
      ? `${completedIn}で保存済みの起動状態から復元しました。公式Wizardを開いています。`
      : `${completedIn}で準備が完了しました。公式Wizardを開いています。`;
  bootElapsed.textContent = `完了 ${completedIn}`;
  bootPatience.hidden = true;
  bootRetry.hidden = true;
  bootPhases.forEach((phase) => {
    phase.dataset.bootState = "complete";
  });
}

function failBoot(): void {
  if (bootTimer !== undefined) {
    window.clearInterval(bootTimer);
    bootTimer = undefined;
  }
  bootProgress.dataset.state = "fail";
  bootTitle.textContent = "起動を完了できませんでした";
  bootDetail.textContent =
    "通信やブラウザのメモリ状態を確認して、もう一度お試しください。";
  bootElapsed.textContent = `停止 ${elapsedLabel()}`;
  bootPatience.hidden = true;
  bootRetry.hidden = false;
}

function showError(message?: string): void {
  wizardError.hidden = !message;
  wizardError.textContent = message ?? "";
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/gateway (?:not connected|closed)|reconnect timed out/iu.test(message)) {
    return "OpenClawとの接続が一時的に途切れました。もう一度お試しください。";
  }
  if (/timed out|応答がありません/iu.test(message)) {
    return "OpenClawからの応答に時間がかかっています。もう一度お試しください。";
  }
  return message.trim().split("\n", 1)[0]
    || "OpenClawのセットアップを続行できませんでした";
}

function isRuntimeUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /gateway (?:not connected|closed)|reconnect timed out|OpenClaw Wizard RPC timed out|ブラウザ内OpenClawから応答がありません/iu
    .test(message);
}

function recoverDisconnectedRuntime(): boolean {
  if (
    runtimeRecoveryInProgress
    || runtimeRecoveryAttempts >= maximumAutomaticRuntimeRecoveries
  ) {
    return false;
  }
  runtimeRecoveryAttempts += 1;
  runtimeRecoveryInProgress = true;
  initialChannelSkipInProgress = false;
  wizardStarted = false;
  wizardSessionId = undefined;
  currentStep = undefined;
  finishing = false;
  capabilityAttached = false;
  showError();
  setWizardBusy("OpenClawとの接続を復旧しています…");
  restartBootProgress();
  bootTitle.textContent = "OpenClawを再接続しています";
  bootDetail.textContent =
    "停止した共有実行環境を切り離し、保存済みの状態から安全に復元します。";
  setStatus("running", "OpenClawを再接続中");
  const epoch = rotateSharedRuntimeEpoch();
  const runtimeUrl = new URL(runtimeFrame.src, location.href);
  runtimeUrl.searchParams.set("runtimeEpoch", epoch);
  runtimeFrame.src = runtimeUrl.href;
  return true;
}

function postRuntimeRequest(
  type:
    | "clawsembly:wizard-capability-attach"
    | "clawsembly:wizard-capability-configure"
    | "clawsembly:wizard-rpc-request",
  payload: Record<string, unknown>,
  timeoutMs = runtimeRequestTimeoutMs
): Promise<unknown> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error("ブラウザ内OpenClawから応答がありません"));
    }, timeoutMs);
    pendingRequests.set(requestId, { reject, resolve, timeout });
    runtimeFrame.contentWindow?.postMessage({
      type,
      requestId,
      ...payload
    }, location.origin);
  });
}

async function rpc(
  method: string,
  params: unknown,
  timeoutMs = runtimeRequestTimeoutMs
): Promise<unknown> {
  const reconnectDeadline = Date.now() + gatewayReconnectWindowMs;
  let retryDelayMs = 150;
  for (;;) {
    try {
      const result = await postRuntimeRequest(
        "clawsembly:wizard-rpc-request",
        { method, params },
        timeoutMs
      );
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        !/gateway not connected/iu.test(message)
        || Date.now() >= reconnectDeadline
      ) {
        throw error;
      }
      setStatus("running", "OpenClawへ再接続中");
      setWizardBusy("接続を回復しています…");
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, retryDelayMs);
      });
      retryDelayMs = Math.min(2_000, retryDelayMs * 2);
    }
  }
}

function normalizeWizardCopy(value: string): string {
  return value
    .replace(
      /\u001B\]8;;([^\u0007\u001B]*)(?:\u0007|\u001B\\)(.*?)\u001B\]8;;(?:\u0007|\u001B\\)/gsu,
      (_match, url: string, label: string) => (
        url && label !== url ? `${label} (${url})` : label || url
      )
    )
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/gu, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\r\n?/gu, "\n")
    .trim();
}

function appendLinkifiedText(target: HTMLElement, value: string): void {
  const urlPattern = /https?:\/\/[^\s)]+/gu;
  let offset = 0;
  for (const match of value.matchAll(urlPattern)) {
    const index = match.index ?? 0;
    target.append(document.createTextNode(value.slice(offset, index)));
    const link = document.createElement("a");
    link.href = match[0];
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = match[0];
    target.append(link);
    offset = index + match[0].length;
  }
  target.append(document.createTextNode(value.slice(offset)));
}

function copyLine(value: string, className?: string): HTMLParagraphElement {
  const paragraph = document.createElement("p");
  if (className) paragraph.className = className;
  appendLinkifiedText(paragraph, value);
  return paragraph;
}

function renderWizardMessage(step: WizardStep): void {
  wizardMessage.replaceChildren();
  wizardMessage.classList.toggle("wizard-message-note", step.type === "note");
  const source = step.title && step.message
    ? step.message
    : "OpenClaw公式Wizardの案内をそのまま表示しています。";
  const normalized = normalizeWizardCopy(source);
  const blocks = normalized.split(/\n\s*\n/gu).filter(Boolean);
  const channelLines = blocks.slice(1).join("\n").split("\n").filter(Boolean);
  if (step.type === "note" && channelLines.length >= 6) {
    const channelPrimer = step.title?.trim() === "How channels work";
    const intro = document.createElement("div");
    intro.className = "wizard-note-intro";
    for (const line of blocks[0].split("\n").filter(Boolean)) {
      intro.append(copyLine(line));
    }
    const details = document.createElement("details");
    details.className = "wizard-note-details";
    const summary = document.createElement("summary");
    summary.textContent = channelPrimer
      ? `対応チャンネル ${channelLines.length}件を見る`
      : step.title?.trim() === "Security disclaimer"
        ? `安全上の注意を詳しく見る（${channelLines.length}項目）`
        : `詳しい案内を見る（${channelLines.length}項目）`;
    const list = document.createElement("ul");
    list.className = channelPrimer
      ? "wizard-channel-list"
      : "wizard-note-line-list";
    for (const line of channelLines) {
      const item = document.createElement("li");
      const separator = line.indexOf(":");
      if (channelPrimer && separator > 0 && separator < 42) {
        const label = document.createElement("strong");
        label.textContent = line.slice(0, separator).trim();
        const detail = document.createElement("span");
        appendLinkifiedText(detail, line.slice(separator + 1).trim());
        item.append(label, detail);
      } else {
        appendLinkifiedText(item, line);
      }
      list.append(item);
    }
    details.append(summary, list);
    wizardMessage.append(intro, details);
    return;
  }
  const lines = normalized.split("\n").filter(Boolean);
  for (const line of lines.length > 0 ? lines : [source]) {
    wizardMessage.append(copyLine(line));
  }
}

function createButton(
  label: string,
  onClick: () => void,
  options?: { hint?: string; primary?: boolean }
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = options?.primary
    ? "wizard-choice wizard-choice-primary"
    : "wizard-choice";
  const title = document.createElement("span");
  title.textContent = label;
  button.append(title);
  if (options?.hint) {
    const hint = document.createElement("small");
    hint.textContent = options.hint;
    button.append(hint);
  }
  button.addEventListener("click", onClick);
  return button;
}

function setWizardBusy(label: string): void {
  wizardControls.replaceChildren();
  const loader = document.createElement("span");
  loader.className = "wizard-loader";
  loader.setAttribute("aria-hidden", "true");
  wizardControls.append(loader, document.createTextNode(label));
}

async function answerWizard(
  step: WizardStep,
  value?: unknown,
  timeoutMs = runtimeRequestTimeoutMs
): Promise<void> {
  if (!wizardSessionId) throw new Error("Wizard session is not available");
  showError();
  setWizardBusy("公式Wizardへ回答を送信中…");
  try {
    const result = await rpc("wizard.next", {
      sessionId: wizardSessionId,
      answer: {
        stepId: step.id,
        ...(value === undefined ? {} : { value })
      }
    }, timeoutMs) as WizardResult;
    await handleWizardResult(result);
  } catch (error) {
    if (isRuntimeUnavailable(error) && recoverDisconnectedRuntime()) return;
    renderWizardStep(step);
    showError(errorMessage(error));
  }
}

function isInitialChannelPrimer(step: WizardStep): boolean {
  if (step.type !== "note") return false;
  if (step.title?.trim() === "How channels work") return true;
  const message = normalizeWizardCopy(step.message ?? "");
  return message.includes("openclaw pairing approve <channel> <code>")
    && message.includes("channels/pairing");
}

function initialChannelSkipValue(step: WizardStep): string | undefined {
  if (!initialChannelSkipInProgress || step.type !== "select") return undefined;
  const values = new Set((step.options ?? []).map((option) => option.value));
  if (values.has("__skip__")) return "__skip__";
  if (values.has("__done__")) return "__done__";
  return undefined;
}

function showInitialChannelSkipProgress(): void {
  currentStep = undefined;
  setStep(1);
  wizardStage.hidden = false;
  credentialAdapter.hidden = true;
  wizardOrigin.textContent = "Clawsembly · 初回セットアップ";
  wizardTitle.textContent = "外部チャネルはあとから追加できます";
  wizardStage.dataset.stepId = "clawsembly-skip-initial-channels";
  wizardStage.dataset.stepType = "progress";
  wizardMessage.classList.remove("wizard-message-note");
  wizardMessage.textContent =
    "まずブラウザで使える状態まで進めます。TelegramやDiscordなどは、必要になったときにOpenClawから追加できます。";
  showError();
  setStatus("running", "初回設定を最適化中");
  setWizardBusy("外部チャネル設定をスキップしています…");
}

function renderSelect(step: WizardStep): void {
  let options = step.options ?? [];
  if (step.message === "Model/auth provider") {
    options = options.filter((option) =>
      option.value === "openai"
      || option.value === "openrouter"
      || option.value === "skip");
  }
  if (options.length === 0) {
    wizardControls.append(createButton(
      "モデル接続を後で設定",
      () => void answerWizard(step, "skip"),
      { primary: true }
    ));
    return;
  }
  for (const option of options) {
    wizardControls.append(createButton(
      option.label,
      () => {
        if (
          step.message === "Model/auth provider"
          && (option.value === "openai" || option.value === "openrouter")
        ) {
          selectedProvider = option.value;
        }
        void answerWizard(step, option.value);
      },
      {
        hint: option.hint,
        primary: option.value === step.initialValue
      }
    ));
  }
}

function renderText(step: WizardStep): void {
  if (step.sensitive) {
    showError(
      "この認証方法はまだ安全な接続へ対応していないため、"
      + "認証情報をOpenClawへ送信しません。前の選択へ戻ってください。"
    );
    return;
  }
  const form = document.createElement("form");
  form.className = "wizard-text-form";
  const input = document.createElement("input");
  input.value = typeof step.initialValue === "string"
    ? step.initialValue
    : "";
  input.placeholder = step.placeholder ?? "";
  input.autocomplete = "off";
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "続ける →";
  form.append(input, submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void answerWizard(step, input.value);
  });
  wizardControls.append(form);
  input.focus();
}

function renderMultiselect(step: WizardStep): void {
  const form = document.createElement("form");
  form.className = "wizard-multiselect";
  const initial = new Set(
    Array.isArray(step.initialValue)
      ? step.initialValue.filter((value): value is string =>
          typeof value === "string")
      : []
  );
  for (const option of step.options ?? []) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = "wizard-option";
    input.value = option.value;
    input.checked = initial.has(option.value);
    const copy = document.createElement("span");
    copy.textContent = option.label;
    label.append(input, copy);
    form.append(label);
  }
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "選択して続ける →";
  form.append(submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = Array.from(
      form.querySelectorAll<HTMLInputElement>(
        "input[name=wizard-option]:checked"
      )
    ).map((input) => input.value);
    void answerWizard(step, values);
  });
  wizardControls.append(form);
}

function isCredentialMethodStep(step: WizardStep): boolean {
  return step.type === "select"
    && (
      step.message === "OpenAI auth method"
      || step.message === "OpenRouter auth method"
    );
}

function showCredentialAdapter(step: WizardStep): void {
  setStep(2);
  wizardStage.hidden = true;
  wizardControls.replaceChildren();
  credentialAdapter.hidden = false;
  credentialAdapter.scrollIntoView({ behavior: "smooth", block: "start" });
  selectedProvider = step.message === "OpenRouter auth method"
    ? "openrouter"
    : "openai";
  provider.value = selectedProvider;
  provider.disabled = selectedProvider === "openrouter";
  oauthStart.hidden = selectedProvider !== "openai";
  if (capabilityAttached && capability) {
    credentialMethods.hidden = true;
    oauthPanel.hidden = true;
    apiKeyPanel.hidden = true;
    credentialResume.hidden = false;
    credentialResult.textContent =
      `${capability.providerLabel} · 安全に接続済み`;
    credentialResult.dataset.state = "ready";
    return;
  }
  credentialMethods.hidden = false;
  oauthPanel.hidden = true;
  apiKeyPanel.hidden = true;
  credentialResume.hidden = true;
  credentialResult.textContent = "";
  credentialResult.dataset.state = "idle";
}

function renderWizardStep(step: WizardStep): void {
  currentStep = step;
  setStep(1);
  wizardStage.hidden = false;
  const typeLabel = {
    action: "操作",
    confirm: "確認",
    multiselect: "複数選択",
    note: "案内",
    progress: "進行状況",
    select: "選択",
    text: "入力"
  }[step.type];
  wizardOrigin.textContent = `OpenClaw 公式Wizard · ${typeLabel}`;
  wizardTitle.textContent = step.title?.trim()
    || step.message?.trim()
    || "OpenClaw setup";
  wizardStage.dataset.stepId = step.id;
  wizardStage.dataset.stepType = step.type;
  renderWizardMessage(step);
  wizardControls.replaceChildren();
  showError();
  setStatus("ready", "OpenClaw 接続済み");

  if (isCredentialMethodStep(step)) {
    showCredentialAdapter(step);
    return;
  }
  credentialAdapter.hidden = true;
  switch (step.type) {
    case "select":
      renderSelect(step);
      break;
    case "text":
      renderText(step);
      break;
    case "confirm":
      wizardControls.append(
        createButton(
          "はい",
          () => void answerWizard(step, true),
          { primary: step.initialValue === true }
        ),
        createButton(
          "いいえ",
          () => void answerWizard(step, false),
          { primary: step.initialValue === false }
        )
      );
      break;
    case "multiselect":
      renderMultiselect(step);
      break;
    case "note":
    case "action":
    case "progress":
      wizardControls.append(createButton(
        "続ける →",
        () => void answerWizard(step),
        { primary: true }
      ));
      break;
  }
}

async function attachCapability(nextCapability: Capability): Promise<void> {
  await postRuntimeRequest("clawsembly:wizard-capability-attach", {
    capability: {
      apiKey: nextCapability.token,
      apiPath: nextCapability.apiPath,
      baseUrl: nextCapability.baseUrl,
      expiresAt: nextCapability.expiresAt,
      model: nextCapability.model,
      modelApi: nextCapability.modelApi,
      openClawProvider: nextCapability.openClawProvider,
      providerId: "clawsembly-byok"
    }
  });
}

async function finishCredential(nextCapability: Capability): Promise<void> {
  if (!currentStep) throw new Error("Wizard credential step is unavailable");
  capability = nextCapability;
  setStatus("running", "モデルを接続中");
  credentialResult.textContent =
    "認証情報を保護したモデル接続を準備しています…";
  credentialResult.dataset.state = "idle";
  try {
    await attachCapability(nextCapability);
    capabilityAttached = true;
  } catch (error) {
    await fetch("/api/byok/capabilities/revoke", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${nextCapability.adminToken}`
      }
    }).catch(() => undefined);
    capability = undefined;
    throw error;
  }
  expiry.textContent = new Intl.DateTimeFormat("ja-JP", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(nextCapability.expiresAt)) + "まで";
  expiry.dataset.state = "ready";
  budget.textContent = `最大${nextCapability.maxRequests}リクエスト`;
  credentialResult.textContent =
    `${nextCapability.providerLabel} · 安全に接続済み`;
  credentialResult.dataset.state = "ready";
  setStatus("ready", "モデル 接続済み");
  credentialAdapter.hidden = true;
  wizardStage.hidden = false;
  await answerWizard(currentStep, "skip");
}

async function issueApiKeyCapability(): Promise<void> {
  connectButton.disabled = true;
  apiKey.disabled = true;
  credentialResult.textContent = "安全な接続を準備しています…";
  credentialResult.dataset.state = "idle";
  try {
    const response = await fetch("/api/byok/capabilities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: provider.value,
        model: model.value.trim(),
        apiKey: apiKey.value
      })
    });
    apiKey.value = "";
    const body = await response.json() as {
      capability?: Capability;
      error?: { code?: string };
      status?: string;
    };
    if (!response.ok || body.status !== "ready" || !body.capability) {
      throw new Error(body.error?.code ?? `HTTP ${response.status}`);
    }
    await finishCredential(body.capability);
  } catch (error) {
    apiKey.value = "";
    credentialResult.textContent = errorMessage(error);
    credentialResult.dataset.state = "fail";
    setStatus("fail", "モデル接続失敗");
  } finally {
    connectButton.disabled = false;
    apiKey.disabled = false;
  }
}

async function pollDeviceAuthorization(
  start: DeviceStartResponse,
  attempt: number
): Promise<void> {
  let retryDelayMs = start.authorization.intervalMs;
  for (;;) {
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, retryDelayMs);
    });
    if (attempt !== oauthAttempt) return;
    const response = await fetch(start.pollUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${start.pollToken}`
      }
    });
    if (attempt !== oauthAttempt) return;
    const body = await response.json() as {
      capability?: Omit<Capability, "adminToken">;
      error?: { code?: string };
      retryAfterMs?: number;
      status?: string;
    };
    if (response.status === 202 && body.status === "authorization_pending") {
      retryDelayMs = typeof body.retryAfterMs === "number"
        && Number.isFinite(body.retryAfterMs)
        ? Math.max(1_000, Math.trunc(body.retryAfterMs))
        : start.authorization.intervalMs;
      oauthStatus.textContent =
        "OpenAI側の承認を待っています。この画面は閉じないでください。";
      continue;
    }
    if (!response.ok || body.status !== "ready" || !body.capability) {
      throw new Error(body.error?.code ?? `HTTP ${response.status}`);
    }
    await finishCredential({
      ...body.capability,
      adminToken: start.adminToken
    });
    return;
  }
}

async function startDeviceAuthorization(): Promise<void> {
  const attempt = ++oauthAttempt;
  oauthStart.disabled = true;
  credentialMethods.hidden = true;
  oauthPanel.hidden = false;
  credentialResume.hidden = true;
  resetOauthCopy();
  oauthStatus.textContent = "OpenAI Device Codeを発行しています…";
  setStatus("running", "OpenAI認証を準備中");
  try {
    const response = await fetch("/api/oauth/openai/device/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol" })
    });
    const body = await response.json() as DeviceStartResponse & {
      error?: { code?: string };
    };
    if (!response.ok || body.status !== "authorization_pending") {
      throw new Error(body.error?.code ?? `HTTP ${response.status}`);
    }
    oauthAdminToken = body.adminToken;
    oauthCode.textContent = body.authorization.userCode;
    oauthCopy.disabled = false;
    oauthCopy.setAttribute(
      "aria-label",
      `認証コード ${body.authorization.userCode} をコピー`
    );
    oauthVerifyLink.href = body.authorization.verificationUrl;
    oauthVerifyLink.setAttribute("aria-disabled", "false");
    oauthExpires.textContent = `${new Intl.DateTimeFormat("ja-JP", {
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date(body.authorization.expiresAt))}まで有効`;
    oauthStatus.textContent =
      "OpenAI側の承認を待っています。この画面は自動で更新されます。";
    setStatus("running", "OpenAIの承認待ち");
    await pollDeviceAuthorization(body, attempt);
  } catch (error) {
    if (attempt !== oauthAttempt) return;
    const failedAdminToken = oauthAdminToken;
    oauthAdminToken = undefined;
    if (failedAdminToken) {
      await fetch("/api/byok/capabilities/revoke", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${failedAdminToken}`
        }
      }).catch(() => undefined);
    }
    oauthStatus.textContent = errorMessage(error);
    setStatus("fail", "OpenAI認証失敗");
    credentialMethods.hidden = false;
    oauthPanel.hidden = true;
  } finally {
    oauthStart.disabled = false;
  }
}

async function applyCapabilityConfig(): Promise<void> {
  if (!capability) return;
  await postRuntimeRequest(
    "clawsembly:wizard-capability-configure",
    {}
  );
}

async function finishWizard(result: WizardResult): Promise<void> {
  if (finishing) return;
  finishing = true;
  setWizardBusy("公式Wizardの設定を確定しています…");
  setStatus("running", "OpenClaw設定を確定中");
  try {
    if (result.status === "error") {
      throw new Error(result.error ?? "Official Wizard failed");
    }
    await applyCapabilityConfig();
    credentialAdapter.hidden = true;
    wizardStage.hidden = true;
    setStep(3);
    wizardOrigin.textContent = "OpenClaw 公式Wizard · 完了";
    wizardTitle.textContent = "OpenClawの準備が完了しました";
    wizardMessage.textContent = capability
      ? "公式Wizardの設定に、認証情報を含まない安全なモデル接続を追加しました。"
      : "公式Wizardを完了しました。モデル接続は後から追加できます。";
    wizardControls.replaceChildren();
    runtimeTitle.textContent = "OpenClawの準備が完了しました";
    runtimeSummary.textContent = capability
      ? `${capability.providerLabel} / ${capability.model} · `
        + "安全な期限付き接続を使用"
      : "モデル接続なしで公式Wizardを完了";
    runtimePanel.hidden = false;
    revokeButton.disabled = !capability;
    setStatus("ready", "OpenClaw 準備完了");
    window.setTimeout(() => runtimePanel.scrollIntoView({
      behavior: "smooth",
      block: "start"
    }), 0);
  } catch (error) {
    finishing = false;
    showError(errorMessage(error));
    setStatus("fail", "設定確定失敗");
    wizardControls.replaceChildren(createButton(
      "設定確定を再試行",
      () => void finishWizard(result),
      { primary: true }
    ));
  }
}

async function handleWizardResult(result: WizardResult): Promise<void> {
  if (result.sessionId) wizardSessionId = result.sessionId;
  if (result.error) showError(result.error);
  if (result.done) {
    await finishWizard(result);
    return;
  }
  if (!result.step) {
    throw new Error("Official Wizard returned no next step");
  }
  if (!result.error && isInitialChannelPrimer(result.step)) {
    initialChannelSkipInProgress = true;
    showInitialChannelSkipProgress();
    await answerWizard(
      result.step,
      undefined,
      initialChannelSkipTimeoutMs
    );
    return;
  }
  const channelSkipValue = initialChannelSkipValue(result.step);
  if (!result.error && channelSkipValue) {
    showInitialChannelSkipProgress();
    await answerWizard(
      result.step,
      channelSkipValue,
      initialChannelSkipTimeoutMs
    );
    return;
  }
  initialChannelSkipInProgress = false;
  renderWizardStep(result.step);
}

async function startWizard(): Promise<void> {
  if (wizardStarted) return;
  wizardStarted = true;
  setStep(1);
  wizardStage.hidden = false;
  setStatus("running", "公式Wizardに接続中");
  setWizardBusy("wizard.startを実行中…");
  try {
    const result = await rpc("wizard.start", {
      mode: "local",
      workspace: "/openclaw/.clawsembly-gateway-workspace"
    }) as WizardResult;
    await handleWizardResult(result);
  } catch (error) {
    wizardStarted = false;
    showError(errorMessage(error));
    setStatus("fail", "Wizard接続失敗");
  }
}

async function resumeWizardAfterGatewayReady(): Promise<void> {
  const recovered = runtimeRecoveryInProgress;
  runtimeRecoveryInProgress = false;
  if (recovered && capability) {
    try {
      await attachCapability(capability);
      capabilityAttached = true;
    } catch (error) {
      showError(errorMessage(error));
      setStatus("fail", "モデル接続の復元に失敗しました");
      return;
    }
  }
  await startWizard();
}

async function revokeCapability(): Promise<void> {
  const active = capability;
  const adminToken = active?.adminToken ?? oauthAdminToken;
  if (!adminToken) return;
  revokeButton.disabled = true;
  try {
    const response = await fetch("/api/byok/capabilities/revoke", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    capability = undefined;
    oauthAdminToken = undefined;
    runtimeSummary.textContent =
      "モデル能力を失効しました。再読み込みして再設定できます。";
    setStatus("idle", "モデル能力 失効済み");
  } catch (error) {
    setStatus("fail", errorMessage(error));
    revokeButton.disabled = false;
  }
}

function startOnboardingRuntime(): void {
  runtimeFrame.contentWindow?.postMessage({
    type: "clawsembly:onboarding-runtime-start"
  }, location.origin);
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
    bootMode?: unknown;
    bootTimings?: unknown;
    label?: unknown;
    openclawVersion?: unknown;
    state?: unknown;
    type?: unknown;
  };
  if (
    message.type === "clawsembly:wizard-rpc-response"
    || message.type === "clawsembly:wizard-capability-response"
    || message.type === "clawsembly:wizard-capability-config-response"
  ) {
    const response = message as RpcResponse;
    const pending = pendingRequests.get(response.requestId);
    if (!pending) return;
    pendingRequests.delete(response.requestId);
    window.clearTimeout(pending.timeout);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new Error(response.error ?? "OpenClaw RPC failed"));
    return;
  }
  if (message.type === "clawsembly:byok-runtime-ready") {
    setBootPhase(0);
    startOnboardingRuntime();
    return;
  }
  if (message.type === "clawsembly:wizard-gateway-ready") {
    if (runtimeHandshakeTimer !== undefined) {
      window.clearInterval(runtimeHandshakeTimer);
      runtimeHandshakeTimer = undefined;
    }
    const bootTimings = message.bootTimings
      && typeof message.bootTimings === "object"
      && !Array.isArray(message.bootTimings)
      ? Object.fromEntries(Object.entries(message.bootTimings).filter(
          (entry): entry is [string, number] => (
            typeof entry[1] === "number" && Number.isFinite(entry[1])
          )
        ))
      : undefined;
    finishBoot(
      message.bootMode === "shared"
        ? "shared"
        : message.bootMode === "warm"
          ? "warm"
          : "cold",
      bootTimings
    );
    wizardOrigin.textContent =
      `OpenClaw 公式Wizard · ${
        typeof message.openclawVersion === "string"
          ? message.openclawVersion
          : "connected"
      }`;
    void resumeWizardAfterGatewayReady();
    return;
  }
  if (
    message.type === "clawsembly:byok-runtime-status"
    && !wizardStarted
  ) {
    const label = typeof message.label === "string"
      ? message.label
      : "ブラウザカーネルを起動中";
    if (message.state === "fail") {
      failBoot();
      setStatus("fail", "起動に失敗しました");
      wizardMessage.textContent =
        "OpenClawを起動できませんでした。上の再試行ボタンからやり直せます。";
      return;
    }
    if (label.toLowerCase().includes("waiting for another clawsembly tab")) {
      setBootPhase(0);
      bootTitle.textContent = "別のタブの起動を待っています";
      bootDetail.textContent =
        "同じ実行環境を二重に展開しないよう、先に開いたタブの完了後に続けます。";
      setStatus("running", "別タブの起動を待機中");
      wizardMessage.textContent = bootDetail.textContent;
      return;
    }
    setBootPhase(phaseForRuntimeLabel(label));
    wizardMessage.textContent = bootCopy[bootPhase].detail;
  }
});

runtimeFrame.addEventListener("load", startOnboardingRuntime);

apiKeyShow.addEventListener("click", () => {
  credentialMethods.hidden = true;
  oauthPanel.hidden = true;
  apiKeyPanel.hidden = false;
  provider.value = selectedProvider;
  provider.disabled = selectedProvider === "openrouter";
  model.value = selectedProvider === "openrouter"
    ? "openai/gpt-5.6"
    : "gpt-5.6-sol";
  apiKey.focus();
});
oauthCopy.addEventListener("click", () => {
  void copyOauthCode();
});
oauthVerifyLink.addEventListener("click", (event) => {
  if (oauthVerifyLink.getAttribute("aria-disabled") === "true") {
    event.preventDefault();
    return;
  }
  void copyOauthCode();
});
oauthBack.addEventListener("click", showCredentialMethods);
apiKeyBack.addEventListener("click", showCredentialMethods);
credentialResumeButton.addEventListener("click", () => {
  if (currentStep) void answerWizard(currentStep, "skip");
});
oauthStart.addEventListener("click", () => {
  void startDeviceAuthorization();
});
apiKeyPanel.addEventListener("submit", (event) => {
  event.preventDefault();
  void issueApiKeyCapability();
});
revokeButton.addEventListener("click", () => {
  void revokeCapability();
});
bootRetry.addEventListener("click", () => {
  location.reload();
});

window.addEventListener("pagehide", () => {
  if (bootTimer !== undefined) window.clearInterval(bootTimer);
  const adminToken = capability?.adminToken ?? oauthAdminToken;
  if (!adminToken) return;
  void fetch("/api/byok/capabilities/revoke", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${adminToken}`
    },
    keepalive: true
  });
  capability = undefined;
  oauthAdminToken = undefined;
});

setStep(0);
setBootPhase(0);
updateBootElapsed();
bootTimer = window.setInterval(updateBootElapsed, 1_000);
startOnboardingRuntime();
runtimeHandshakeTimer = window.setInterval(() => {
  if (wizardStarted) {
    if (runtimeHandshakeTimer !== undefined) {
      window.clearInterval(runtimeHandshakeTimer);
      runtimeHandshakeTimer = undefined;
    }
    return;
  }
  startOnboardingRuntime();
}, 500);
