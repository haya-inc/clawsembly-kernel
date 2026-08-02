const runtimeEpochPattern = /^[A-Za-z0-9_-]{1,64}$/u;

export const sharedRuntimeEpochStorageKey =
  "clawsembly-openclaw-runtime-epoch-v1";

export function readSharedRuntimeEpoch(search = location.search): string {
  const requested = new URLSearchParams(search).get("runtimeEpoch");
  if (requested && runtimeEpochPattern.test(requested)) return requested;
  try {
    const stored = localStorage.getItem(sharedRuntimeEpochStorageKey);
    return stored && runtimeEpochPattern.test(stored) ? stored : "initial";
  } catch {
    return "initial";
  }
}

export function rotateSharedRuntimeEpoch(): string {
  const epoch = crypto.randomUUID();
  try {
    localStorage.setItem(sharedRuntimeEpochStorageKey, epoch);
  } catch {
    // The iframe query parameter still isolates the recovering runtime.
  }
  return epoch;
}
