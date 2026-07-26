import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import sqlite3InitModule from "./sqlite3-node.mjs";
import { createNodeSqlitePersonality } from "./node-sqlite-personality.mjs";

const personalitySymbol = Symbol.for("clawsembly.kernel.node:sqlite");
const bootstrapSymbol = Symbol.for("clawsembly.kernel.edgejs.bootstrap");

export async function installEdgeJsKernel(options) {
  if (globalThis[bootstrapSymbol]) return globalThis[bootstrapSymbol];

  const sqlite3 = await sqlite3InitModule({
    locateFile: () => fileURLToPath(new URL("./sqlite3.wasm", import.meta.url))
  });
  const personality = createNodeSqlitePersonality(sqlite3, {
    allowedPathRoots: options?.sqlite?.allowedPathRoots
  });
  globalThis[personalitySymbol] = personality;

  const hook = registerHooks({
    load(url, context, nextLoad) {
      if (url !== "node:sqlite") return nextLoad(url, context);
      return {
        format: "commonjs",
        shortCircuit: true,
        source: `
          const personality = globalThis[Symbol.for("clawsembly.kernel.node:sqlite")];
          module.exports = personality;
          module.exports.DatabaseSync = personality.DatabaseSync;
          module.exports.StatementSync = personality.StatementSync;
          module.exports.clawsembly = personality.clawsembly;
        `
      };
    }
  });

  const installed = Object.freeze({
    hook,
    personality,
    runtime: Object.freeze({
      edge: process.versions.edge ?? null,
      node: process.versions.node,
      v8: process.versions.v8
    })
  });
  globalThis[bootstrapSymbol] = installed;
  return installed;
}
