import test from "node:test";
import assert from "node:assert/strict";
import {
  createOpenClawBootStoreId,
  restoreOrCreateOpenClawBootState
} from "../src/openclaw-boot-cache.ts";

test("keys boot state by both immutable runtime artifacts", () => {
  assert.equal(
    createOpenClawBootStoreId({
      artifactSha256: "a".repeat(64),
      imageSha256: "b".repeat(64)
    }),
    "clawsembly-onboard-v1-aaaaaaaaaaaa-bbbbbbbbbbbb"
  );
  assert.throws(
    () => createOpenClawBootStoreId({
      artifactSha256: "short",
      imageSha256: "b".repeat(64)
    }),
    /complete SHA-256 identities/u
  );
});

test("uses a clean boot after a failed cached restore", async () => {
  let coldBoots = 0;
  const resolution = await restoreOrCreateOpenClawBootState({
    restore: async () => {
      throw new Error("snapshot hash mismatch");
    },
    coldBoot: async () => {
      coldBoots += 1;
      return "fresh-state";
    }
  });

  assert.deepEqual(resolution, {
    fallbackError: "snapshot hash mismatch",
    mode: "cold",
    value: "fresh-state"
  });
  assert.equal(coldBoots, 1);
});

test("does not run a clean boot after a verified restore", async () => {
  let coldBoots = 0;
  const resolution = await restoreOrCreateOpenClawBootState({
    restore: async () => "verified-state",
    coldBoot: async () => {
      coldBoots += 1;
      return "fresh-state";
    }
  });

  assert.deepEqual(resolution, {
    mode: "warm",
    value: "verified-state"
  });
  assert.equal(coldBoots, 0);
});
