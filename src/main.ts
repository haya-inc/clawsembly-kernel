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

const databasePath = "/clawsembly/kernel-m0.sqlite3";

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
  status.textContent = "Writing from worker one…";
  result.textContent = "";

  try {
    const write = await executeWorker({
      id: crypto.randomUUID(),
      kind: "write",
      databasePath
    });
    status.textContent = "Reopening from a fresh worker…";
    const read = await executeWorker({
      id: crypto.randomUUID(),
      kind: "read",
      databasePath
    });
    const persisted = JSON.stringify(write.rows) === JSON.stringify(read.rows)
      && read.rows.length === 2;
    if (!persisted) throw new Error("OPFS rows did not survive the worker boundary");

    const evidence = {
      status: "pass",
      crossOriginIsolated,
      workerGenerations: 2,
      write,
      read
    };
    status.dataset.state = "pass";
    status.textContent = "PASS · persisted across two workers";
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
