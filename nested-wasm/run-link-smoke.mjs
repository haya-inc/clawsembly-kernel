import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const artifactPath = process.argv[2];
if (!artifactPath) {
  throw new Error("Usage: node run-link-smoke.mjs <linked-smoke.wasm>");
}

const bytes = readFileSync(artifactPath);
const module = new WebAssembly.Module(bytes);
const imports = WebAssembly.Module.imports(module);
const expectedImports = new Set([
  "env.abort",
  "env.free",
  "env.malloc",
  "env.memory"
]);
for (const entry of imports) {
  if (!expectedImports.delete(`${entry.module}.${entry.name}`)) {
    throw new Error(
      `Unexpected nested WebAssembly link-smoke import: `
      + `${entry.module}.${entry.name}`
    );
  }
}
if (expectedImports.size !== 0) {
  throw new Error(
    `Missing nested WebAssembly link-smoke imports: `
    + [...expectedImports].join(", ")
  );
}

let allocationCursor = 2 * 65_536;
let instance;
const memory = new WebAssembly.Memory({
  initial: 2,
  maximum: 65_536,
  shared: true
});
const align = (value, alignment) =>
  Math.ceil(value / alignment) * alignment;
instance = new WebAssembly.Instance(module, {
  env: {
    abort() {
      throw new Error("Nested WebAssembly link-smoke guest aborted");
    },
    free() {},
    malloc(size) {
      const pointer = align(allocationCursor, 16);
      allocationCursor = pointer + Math.max(Number(size), 1);
      const requiredPages = Math.ceil(
        (allocationCursor - memory.buffer.byteLength) / 65_536
      );
      if (requiredPages > 0) memory.grow(requiredPages);
      return pointer;
    },
    memory
  }
});

const answer = instance.exports.clawsembly_nested_link_probe();
if (answer !== 1) {
  throw new Error(`Nested WebAssembly engine smoke returned ${answer}`);
}

process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  status: "pass",
  answer,
  artifactBytes: bytes.byteLength,
  artifactSha256: createHash("sha256").update(bytes).digest("hex"),
  imports: imports.map(({ kind, module: namespace, name }) => ({
    kind,
    module: namespace,
    name
  })),
  resolvedCapiCalls: [
    "wasm_engine_new",
    "wasm_engine_delete"
  ]
}, null, 2)}\n`);
