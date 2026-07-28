import assert from "node:assert/strict";
import { test } from "node:test";
import { parseClawsemblyFs } from "../src/clawsemblyfs.ts";

const magic = Buffer.from("CLAWSEMBLYFS1\n", "ascii");

function image(
  entries: Array<{ content: string; mode?: number; path: string }>,
  options: { trailing?: Uint8Array; version?: number } = {}
): Uint8Array {
  const parts: Uint8Array[] = [];
  const preamble = Buffer.alloc(magic.byteLength + 8);
  magic.copy(preamble);
  preamble.writeUInt32BE(options.version ?? 1, magic.byteLength);
  preamble.writeUInt32BE(entries.length, magic.byteLength + 4);
  parts.push(preamble);
  for (const entry of entries) {
    const pathBytes = Buffer.from(entry.path, "utf8");
    const content = Buffer.from(entry.content, "utf8");
    const header = Buffer.alloc(16);
    header.writeUInt32BE(pathBytes.byteLength, 0);
    header.writeUInt32BE(entry.mode ?? 0o644, 4);
    header.writeBigUInt64BE(BigInt(content.byteLength), 8);
    parts.push(header, pathBytes, content);
  }
  if (options.trailing) parts.push(options.trailing);
  return Buffer.concat(parts);
}

test("parses a deterministic ClawsemblyFS image without copying file bytes", () => {
  const bytes = image([
    { path: "/openclaw.mjs", content: "launcher" },
    {
      path: "/node_modules/example/package.json",
      content: "{\"name\":\"example\"}"
    }
  ]);
  const parsed = parseClawsemblyFs(bytes);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.fileCount, 2);
  assert.equal(parsed.payloadBytes, 26);
  assert.equal(
    new TextDecoder().decode(parsed.files["/openclaw.mjs"]),
    "launcher"
  );
  assert.equal(
    new TextDecoder().decode(
      parsed.files["/node_modules/example/package.json"]
    ),
    "{\"name\":\"example\"}"
  );
  assert.equal(
    parsed.files["/openclaw.mjs"].buffer,
    bytes.buffer,
    "file views should share the source image buffer"
  );
});

test("rejects path traversal and duplicate paths", () => {
  assert.throws(
    () => parseClawsemblyFs(image([{ path: "/../escape", content: "x" }])),
    /Unsafe ClawsemblyFS path/u
  );
  assert.throws(
    () => parseClawsemblyFs(image([
      { path: "/same", content: "a" },
      { path: "/same", content: "b" }
    ])),
    /Duplicate ClawsemblyFS path/u
  );
});

test("rejects corrupt framing", () => {
  const valid = image([{ path: "/a", content: "value" }]);
  const wrongMagic = Uint8Array.from(valid);
  wrongMagic[0] ^= 0xff;
  assert.throws(
    () => parseClawsemblyFs(wrongMagic),
    /Invalid ClawsemblyFS magic/u
  );
  assert.throws(
    () => parseClawsemblyFs(image([], { version: 2 })),
    /Unsupported ClawsemblyFS version/u
  );
  assert.throws(
    () => parseClawsemblyFs(valid.subarray(0, valid.byteLength - 1)),
    /Truncated ClawsemblyFS entry 0 content/u
  );
  assert.throws(
    () => parseClawsemblyFs(image([], { trailing: Uint8Array.of(1) })),
    /trailing bytes/u
  );
});
