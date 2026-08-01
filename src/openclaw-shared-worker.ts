type RuntimeMessage = {
  message?: unknown;
  method?: unknown;
  ok?: unknown;
  requestId?: unknown;
  result?: unknown;
  type?: unknown;
};

type SharedWorkerScope = typeof globalThis & {
  onconnect: ((event: MessageEvent) => void) | null;
};

const workerScope = globalThis as SharedWorkerScope;
const ports = new Set<MessagePort>();
const requestOwners = new Map<string, MessagePort>();
const requestMethods = new Map<string, string>();
const wizardStartWaiters: Array<{
  port: MessagePort;
  requestId: string;
}> = [];
let owner: MessagePort | undefined;
let readyMessage: unknown;
let resultMessage: unknown;
let runtimeRequested = false;
let wizardSnapshot: unknown;
let wizardStartInFlight = false;
let statusMessage: unknown = {
  type: "clawsembly:byok-runtime-status",
  state: "running",
  label: "Waiting for the shared OpenClaw owner…"
};

function send(port: MessagePort, message: unknown): void {
  try {
    port.postMessage(message);
  } catch {
    disconnect(port);
  }
}

function broadcast(message: unknown): void {
  for (const port of [...ports]) send(port, message);
}

function chooseOwner(): void {
  owner = ports.values().next().value as MessagePort | undefined;
  if (!owner) return;
  readyMessage = undefined;
  resultMessage = undefined;
  statusMessage = {
    type: "clawsembly:byok-runtime-status",
    state: "running",
    label: "Restoring the shared OpenClaw owner…"
  };
  broadcast(statusMessage);
  send(owner, { type: "clawsembly:shared-runtime-owner" });
  if (runtimeRequested) {
    send(owner, { type: "clawsembly:shared-runtime-owner-start" });
  }
}

function disconnect(port: MessagePort): void {
  ports.delete(port);
  for (const [requestId, requestOwner] of requestOwners) {
    if (requestOwner === port) requestOwners.delete(requestId);
  }
  if (owner === port) {
    owner = undefined;
    requestOwners.clear();
    requestMethods.clear();
    wizardSnapshot = undefined;
    wizardStartInFlight = false;
    wizardStartWaiters.length = 0;
    chooseOwner();
  }
}

function isRuntimeOperation(message: RuntimeMessage): boolean {
  return message.type === "clawsembly:wizard-rpc-request"
    || message.type === "clawsembly:wizard-capability-attach"
    || message.type === "clawsembly:wizard-capability-configure";
}

function sharedReady(message: unknown): unknown {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return message;
  }
  return {
    ...message,
    ownerBootMode: (message as { bootMode?: unknown }).bootMode,
    bootMode: "shared"
  };
}

function routeOwnerOutput(message: unknown): void {
  const candidate = message as RuntimeMessage;
  if (
    typeof candidate.requestId === "string"
    && (
      candidate.type === "clawsembly:wizard-rpc-response"
      || candidate.type === "clawsembly:wizard-capability-response"
      || candidate.type === "clawsembly:wizard-capability-config-response"
    )
  ) {
    const requester = requestOwners.get(candidate.requestId);
    const method = requestMethods.get(candidate.requestId);
    if (requester || method) {
      requestOwners.delete(candidate.requestId);
      requestMethods.delete(candidate.requestId);
      if (
        candidate.ok === true
        && (
          method === "wizard.start"
          || method === "wizard.next"
          || method === "wizard.status"
        )
      ) {
        wizardSnapshot = candidate.result;
      } else if (method === "wizard.cancel") {
        wizardSnapshot = undefined;
      }
      if (requester) send(requester, message);
      if (method === "wizard.start") {
        wizardStartInFlight = false;
        for (const waiter of wizardStartWaiters.splice(0)) {
          send(waiter.port, {
            ...candidate,
            requestId: waiter.requestId
          });
        }
      }
      return;
    }
  }
  if (candidate.type === "clawsembly:wizard-gateway-ready") {
    readyMessage = message;
    for (const port of [...ports]) {
      send(port, port === owner ? message : sharedReady(message));
    }
    return;
  } else if (candidate.type === "clawsembly:byok-runtime-status") {
    statusMessage = message;
  } else if (candidate.type === "clawsembly:shared-runtime-result") {
    resultMessage = message;
  }
  broadcast(message);
}

workerScope.onconnect = (event: MessageEvent): void => {
  const port = event.ports[0];
  if (!port) return;
  ports.add(port);
  const becomesOwner = owner === undefined;
  if (becomesOwner) owner = port;
  port.onmessage = (messageEvent: MessageEvent<unknown>) => {
    const message = messageEvent.data as RuntimeMessage;
    if (message.type === "clawsembly:shared-runtime-disconnect") {
      disconnect(port);
      port.close();
      return;
    }
    if (message.type === "clawsembly:shared-runtime-owner-output") {
      if (port === owner) routeOwnerOutput(message.message);
      return;
    }
    if (
      message.type === "clawsembly:onboarding-runtime-start"
      || message.type === "clawsembly:byok-runtime-start"
    ) {
      runtimeRequested = true;
      if (owner) {
        send(owner, { type: "clawsembly:shared-runtime-owner-start" });
      }
      return;
    }
    if (!isRuntimeOperation(message) || !owner) return;
    if (
      message.type === "clawsembly:wizard-rpc-request"
      && message.method === "wizard.start"
      && wizardSnapshot !== undefined
      && typeof message.requestId === "string"
    ) {
      send(port, {
        type: "clawsembly:wizard-rpc-response",
        requestId: message.requestId,
        ok: true,
        result: wizardSnapshot
      });
      return;
    }
    if (
      message.type === "clawsembly:wizard-rpc-request"
      && message.method === "wizard.start"
      && wizardStartInFlight
      && typeof message.requestId === "string"
    ) {
      wizardStartWaiters.push({ port, requestId: message.requestId });
      return;
    }
    if (typeof message.requestId === "string") {
      requestOwners.set(message.requestId, port);
      if (typeof message.method === "string") {
        requestMethods.set(message.requestId, message.method);
      }
      if (
        message.type === "clawsembly:wizard-rpc-request"
        && message.method === "wizard.start"
      ) {
        wizardStartInFlight = true;
      }
    }
    send(owner, {
      type: "clawsembly:shared-runtime-owner-input",
      message: messageEvent.data
    });
  };
  port.start();
  send(port, {
    type: becomesOwner
      ? "clawsembly:shared-runtime-owner"
      : "clawsembly:shared-runtime-follower"
  });
  send(port, statusMessage);
  if (resultMessage) send(port, resultMessage);
  if (readyMessage) {
    send(port, port === owner ? readyMessage : sharedReady(readyMessage));
  }
};
