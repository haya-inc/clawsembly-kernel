import type { ProbeCommand, ProbeEvidence, ProbeResponse } from "./protocol";
import "./style.css";

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

const runButton = requiredElement<HTMLButtonElement>("#run");
const status = requiredElement<HTMLOutputElement>("#status");
const result = requiredElement<HTMLPreElement>("#result");

const databasePath = "/clawsembly/openclaw-state-contract-v1.sqlite3";

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

async function runProbe(): Promise<void> {
  runButton.disabled = true;
  status.dataset.state = "running";
  status.textContent = "Initializing the official OpenClaw state schema…";
  result.textContent = "";

  try {
    const runId = crypto.randomUUID();
    const write = await executeWorker({
      id: crypto.randomUUID(),
      kind: "write",
      databasePath,
      attachedDatabasePath: `/clawsembly/attached-${runId}.sqlite3`,
      snapshotDatabasePath: `/clawsembly/snapshot-${runId}.sqlite3`
    });
    status.textContent = "Reopening the state database from a fresh worker…";
    const read = await executeWorker({
      id: crypto.randomUUID(),
      kind: "read",
      databasePath
    });
    const persisted = write.stateSchema.sha256 === read.stateSchema.sha256
      && write.stateSchema.tables === read.stateSchema.tables
      && write.stateSchema.indexes === read.stateSchema.indexes
      && JSON.stringify(write.stateSchema.primary) === JSON.stringify(read.stateSchema.primary);
    if (!persisted) {
      throw new Error("The OpenClaw state contract did not survive the worker boundary");
    }

    const evidence = {
      status: "pass",
      crossOriginIsolated,
      workerGenerations: 2,
      write,
      read
    };
    status.dataset.state = "pass";
    status.textContent = "PASS · official OpenClaw state persisted";
    result.textContent = JSON.stringify(evidence, (_, value) => (
      typeof value === "bigint" ? value.toString() : value
    ), 2);
  } catch (error) {
    status.dataset.state = "fail";
    status.textContent = "FAIL";
    result.textContent = error instanceof Error
      ? `${error.message}\n${error.stack ?? ""}`
      : String(error);
    throw error;
  } finally {
    runButton.disabled = false;
  }
}

runButton.addEventListener("click", () => {
  void runProbe();
});

void runProbe();
