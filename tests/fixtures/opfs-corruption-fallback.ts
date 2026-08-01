import { Directory, init } from "@wasmer/sdk";
import {
  restoreOrCreateOpenClawBootState
} from "../../src/openclaw-boot-cache";
import {
  commitDirectoryTreeToOpfs,
  restoreDirectoryTreeFromOpfs
} from "../../src/opfs-directory-store";

const status = document.querySelector<HTMLOutputElement>("#status")!;
const result = document.querySelector<HTMLPreElement>("#result")!;
const encoder = new TextEncoder();

async function run(): Promise<void> {
  await init();
  const storeId = `corruption-${crypto.randomUUID()}`;
  const source = new Directory();
  await source.createDir("/state");
  await source.writeFile("/state/openclaw.sqlite", encoder.encode(
    "verified-before-snapshot"
  ));
  const snapshot = await commitDirectoryTreeToOpfs({
    directory: source,
    rootPath: "/state",
    storeId
  });

  let store = await navigator.storage.getDirectory();
  for (const segment of [
    "clawsembly-kernel",
    "directory-stores",
    storeId
  ]) {
    store = await store.getDirectoryHandle(segment);
  }
  const headHandle = await store.getFileHandle("HEAD.json");
  const head = JSON.parse(await (await headHandle.getFile()).text()) as {
    generationId: string;
    manifestSha256: string;
    schemaVersion: 1;
  };
  const writable = await headHandle.createWritable();
  await writable.write(encoder.encode(`${JSON.stringify({
    ...head,
    manifestSha256: "0".repeat(64)
  })}\n`));
  await writable.close();

  let coldDirectory: Directory | undefined;
  const resolution = await restoreOrCreateOpenClawBootState({
    restore: async () => {
      const restored = new Directory();
      await restoreDirectoryTreeFromOpfs({
        directory: restored,
        rootPath: "/state",
        storeId
      });
      return "restored";
    },
    coldBoot: async () => {
      coldDirectory = new Directory();
      await coldDirectory.createDir("/state");
      await coldDirectory.writeFile(
        "/state/fresh.marker",
        encoder.encode("clean-fallback")
      );
      return "fresh";
    }
  });
  const fallbackMarker = new TextDecoder().decode(
    await coldDirectory!.readFile("/state/fresh.marker")
  );
  if (
    resolution.mode !== "cold"
    || !resolution.fallbackError?.includes("manifest hash mismatch")
    || fallbackMarker !== "clean-fallback"
  ) {
    throw new Error("Corrupt OPFS snapshot did not trigger a clean fallback");
  }
  status.dataset.state = "pass";
  status.textContent = "PASS";
  result.textContent = JSON.stringify({
    fallbackMarker,
    resolution,
    snapshot
  }, null, 2);
}

void run().catch((error) => {
  status.dataset.state = "fail";
  status.textContent = "FAIL";
  result.textContent = error instanceof Error
    ? `${error.message}\n${error.stack ?? ""}`
    : String(error);
});
