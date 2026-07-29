import assert from "node:assert/strict";
import test from "node:test";
import {
  requireEvidence
} from "../scripts/prepare-cloudflare-deploy.mjs";

const sourceCommit = "a".repeat(40);
const proofRunUrl =
  "https://github.com/haya-inc/clawsembly-kernel/actions/runs/123";

function completeEvidence() {
  return {
    schemaVersion: 8,
    clawsemblySource: {
      commit: sourceCommit,
      proofRunUrl
    },
    reproducibleBuild: {
      edgeDistribution: {
        status: "repeat-package-byte-for-byte-pass"
      },
      browserExecutor: {
        status: "repeat-build-byte-for-byte-pass"
      }
    },
    browser: { status: "pass" },
    persistentState: { status: "fresh-browser-opfs-recovery-pass" },
    openclawRuntimeProof: {
      healthRpc: { status: "gateway-health-pass" },
      agentTurn: { status: "agent-turn-pass" },
      workspaceToolTurn: { status: "workspace-tool-turn-pass" },
      selfHostedAgentTurn: {
        status: "self-hosted-agent-turn-pass",
        selfHostedModel: {
          capabilityBroker: {
            hostProcess: {
              revocation: { status: "revoked" },
              rejectedAfterRevocation: {
                httpStatus: 403,
                body: {
                  error: { code: "capability_revoked" }
                }
              }
            }
          }
        }
      }
    }
  };
}

test("accepts reproducible evidence bound to the requested source and run", () => {
  assert.doesNotThrow(() => {
    requireEvidence(completeEvidence(), sourceCommit, proofRunUrl);
  });
});

for (const [name, mutate] of [
  [
    "source commit mismatch",
    (evidence) => {
      evidence.clawsemblySource.commit = "b".repeat(40);
    }
  ],
  [
    "proof run mismatch",
    (evidence) => {
      evidence.clawsemblySource.proofRunUrl =
        "https://github.com/haya-inc/clawsembly-kernel/actions/runs/456";
    }
  ],
  [
    "missing browser-executor reproducibility proof",
    (evidence) => {
      evidence.reproducibleBuild.browserExecutor.status = "not-proven";
    }
  ],
  [
    "missing Edge.js reproducibility proof",
    (evidence) => {
      evidence.reproducibleBuild.edgeDistribution.status = "not-proven";
    }
  ]
]) {
  test(`rejects ${name}`, () => {
    const evidence = completeEvidence();
    mutate(evidence);
    assert.throws(
      () => requireEvidence(evidence, sourceCommit, proofRunUrl),
      /Refusing to deploy incomplete proof evidence/u
    );
  });
}
