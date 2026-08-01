export type OpenClawBootResolution<T> = {
  fallbackError?: string;
  mode: "cold" | "warm";
  value: T;
};

export function createOpenClawBootStoreId(options: {
  artifactSha256: string;
  imageSha256: string;
}): string {
  if (
    !/^[0-9a-f]{64}$/u.test(options.artifactSha256)
    || !/^[0-9a-f]{64}$/u.test(options.imageSha256)
  ) {
    throw new Error("OpenClaw boot cache requires complete SHA-256 identities");
  }
  return `clawsembly-onboard-v1-${options.artifactSha256.slice(0, 12)}-${
    options.imageSha256.slice(0, 12)
  }`;
}

export async function restoreOrCreateOpenClawBootState<T>(options: {
  coldBoot: () => Promise<T>;
  onRestoreFailure?: (message: string) => void;
  restore: () => Promise<T>;
}): Promise<OpenClawBootResolution<T>> {
  try {
    return {
      mode: "warm",
      value: await options.restore()
    };
  } catch (error) {
    const fallbackError = error instanceof Error
      ? error.message
      : String(error);
    options.onRestoreFailure?.(fallbackError);
    return {
      fallbackError,
      mode: "cold",
      value: await options.coldBoot()
    };
  }
}
