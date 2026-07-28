import type { ProbeCommand, ProbeEvidence, ProbeResponse } from "./protocol";
import "./style.css";

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

const runButton = requiredElement<HTMLButtonElement>("#run");
const downloadButton = requiredElement<HTMLButtonElement>("#download");
const status = requiredElement<HTMLOutputElement>("#status");
const result = requiredElement<HTMLPreElement>("#result");
const workerCount = requiredElement<HTMLElement>("#worker-count");
const schemaCount = requiredElement<HTMLElement>("#schema-count");
const persistenceState =
  requiredElement<HTMLElement>("#persistence-state");
const evidenceDisclosure = requiredElement<HTMLDetailsElement>(".evidence");

const databasePath = "/clawsembly/openclaw-state-contract-v1.sqlite3";
let latestEvidence: string | undefined;

function executeWorker(command: ProbeCommand): Promise<ProbeEvidence> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./runtime-worker.ts", import.meta.url), {
      type: "module",
      name: `clawsembly-${command.kind}`
    });
    const timer = window.setTimeout(() => {
      worker.terminate();
      reject(new Error(`${command.kind} worker timed out`));
    }, 30_000);
    worker.addEventListener("message", (event: MessageEvent<ProbeResponse>) => {
      if (event.data.id !== command.id) return;
      window.clearTimeout(timer);
      worker.terminate();
      if (event.data.ok) resolve(event.data.evidence);
      else reject(new Error(event.data.error));
    });
    worker.addEventListener("error", (event) => {
      window.clearTimeout(timer);
      worker.terminate();
      reject(event.error ?? new Error(event.message));
    });
    worker.postMessage(command);
  });
}

function setStatus(
  state: "idle" | "running" | "pass" | "fail",
  label: string
): void {
  status.dataset.state = state;
  status.innerHTML = "";
  const dot = document.createElement("span");
  dot.className = "status-dot";
  dot.setAttribute("aria-hidden", "true");
  status.append(dot, document.createTextNode(label));
}

function serializeEvidence(value: unknown): string {
  return JSON.stringify(value, (_, entry) => (
    typeof entry === "bigint" ? entry.toString() : entry
  ), 2);
}

async function runProbe(): Promise<void> {
  runButton.disabled = true;
  downloadButton.disabled = true;
  latestEvidence = undefined;
  setStatus("running", "Writing schema");
  result.textContent = "";
  workerCount.textContent = "1 / 2";
  schemaCount.textContent = "measuring";
  persistenceState.textContent = "pending";
  persistenceState.dataset.state = "running";

  try {
    const runId = crypto.randomUUID();
    const write = await executeWorker({
      id: crypto.randomUUID(),
      kind: "write",
      databasePath,
      attachedDatabasePath: `/clawsembly/attached-${runId}.sqlite3`,
      snapshotDatabasePath: `/clawsembly/snapshot-${runId}.sqlite3`
    });
    setStatus("running", "Fresh Worker read");
    workerCount.textContent = "2 / 2";
    schemaCount.textContent =
      String(write.stateSchema.tables + write.stateSchema.indexes);
    const read = await executeWorker({
      id: crypto.randomUUID(),
      kind: "read",
      databasePath
    });
    const persisted = write.stateSchema.sha256 === read.stateSchema.sha256
      && write.stateSchema.tables === read.stateSchema.tables
      && write.stateSchema.indexes === read.stateSchema.indexes
      && JSON.stringify(write.stateSchema.primary)
        === JSON.stringify(read.stateSchema.primary);
    if (!persisted) {
      throw new Error(
        "The OpenClaw state contract did not survive the worker boundary"
      );
    }

    const evidence = {
      schemaVersion: 1,
      status: "pass",
      contract: "artifact-derived-openclaw-state",
      crossOriginIsolated,
      workerGenerations: 2,
      write,
      read
    };
    setStatus("pass", "PASS · official OpenClaw state persisted");
    persistenceState.textContent = "verified";
    persistenceState.dataset.state = "pass";
    latestEvidence = `${serializeEvidence(evidence)}\n`;
    result.textContent = latestEvidence;
    downloadButton.disabled = false;
  } catch (error) {
    setStatus("fail", "FAIL");
    persistenceState.textContent = "failed";
    persistenceState.dataset.state = "fail";
    const errorText = error instanceof Error
      ? `${error.message}\n${error.stack ?? ""}`
      : String(error);
    result.textContent = errorText;
    evidenceDisclosure.open = true;
  } finally {
    runButton.disabled = false;
  }
}

runButton.addEventListener("click", () => {
  void runProbe();
});

downloadButton.addEventListener("click", () => {
  if (!latestEvidence) return;
  const url = URL.createObjectURL(new Blob(
    [latestEvidence],
    { type: "application/json" }
  ));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "clawsembly-local-contract-evidence.json";
  anchor.click();
  URL.revokeObjectURL(url);
});

void runProbe();
