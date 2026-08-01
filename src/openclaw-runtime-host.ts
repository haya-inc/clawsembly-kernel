export type OpenClawRuntimeStatusTarget = {
  dataset: Record<string, string | undefined>;
  textContent: string | null;
};

export type OpenClawRuntimeResultTarget = {
  textContent: string | null;
};

export type OpenClawRuntimeHost = {
  addMessageListener(listener: (data: unknown) => void): void;
  origin: string;
  postMessage(message: unknown): void;
  result: OpenClawRuntimeResultTarget;
  search: string;
  status: OpenClawRuntimeStatusTarget;
};

declare global {
  var __clawsemblyOpenClawRuntimeHost:
    | OpenClawRuntimeHost
    | undefined;
}

export function currentOpenClawRuntimeHost():
  | OpenClawRuntimeHost
  | undefined {
  return globalThis.__clawsemblyOpenClawRuntimeHost;
}
