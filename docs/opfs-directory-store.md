# OPFS capability-directory store

OpenClaw executes against an in-memory Wasmer `Directory` capability. The
immutable package image is integrity-pinned and can be mounted again, but the
mutable state subtree must survive loss of the page, Worker, Wasmer runtime,
and browser process.

`src/opfs-directory-store.ts` provides that boundary without exposing OPFS or
an ambient host filesystem to the guest. It stores only one explicitly named
subtree under an explicitly named store.

## Commit contract

Each commit writes a new immutable generation:

```text
clawsembly-kernel/
  directory-stores/<store-id>/
    HEAD.json
    generations/<generation-id>/
      manifest.json
      payload/...
```

The broker recursively reads the granted Wasmer subtree, rejects unknown entry
types and unsafe paths, copies every file into the generation payload, and
records every directory, file length, and file SHA-256 in `manifest.json`.
It writes `HEAD.json` only after the payload and manifest have closed
successfully. `HEAD.json` contains the generation ID and manifest SHA-256, so a
partially written generation is unreachable and cannot be mistaken for the
committed state.

OPFS is obtained through the documented
[`navigator.storage.getDirectory()`](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/getDirectory)
origin-private storage boundary. The browser's persistent-storage grant is
requested and its before/after state is recorded in evidence, but the kernel
does not misreport a denied browser policy as a successful grant.
The restart proof covers normal browser shutdown and relaunch. It does not
claim survival after the user clears site data or the browser evicts an origin
whose persistent-storage request was denied; product UI must surface that
browser policy and provide export or backup separately.

## Recovery contract

Recovery starts from a new Wasmer `Directory` containing the same immutable
OpenClaw package image. The broker:

1. reads the committed HEAD;
2. verifies the exact manifest SHA-256;
3. validates all store, generation, root, directory, and file paths;
4. creates only the manifest-declared directories below the granted root;
5. verifies every payload length and SHA-256 before writing it into the new
   capability directory; and
6. rejects duplicate paths, missing parents, unknown entries, oversized
   payloads, or any identity mismatch.

The resulting guest still sees only its `/openclaw` mount. It receives no
`FileSystemDirectoryHandle`, OPFS path, browser storage API, or authority over
another store.

## Browser-restart proof

`tests/openclaw-opfs-persistence-browser.spec.ts` uses two real Chromium
processes over one temporary persistent origin profile:

1. the first browser mounts the exact official OpenClaw image;
2. the unmodified OpenClaw and `protobufjs` lifecycle scripts create the
   installed-plugin SQLite registry;
3. the broker commits that state subtree to OPFS and the browser closes;
4. a second Chromium process opens the same profile and restores a new Wasmer
   directory from the committed generation;
5. lifecycle scripts are not re-executed; and
6. a new Edge.js WASIX process opens the restored SQLite database through
   `node:sqlite` and verifies host contract `2026.7.1-2`, 33 indexed plugins,
   migration version 1, and refresh reason `migration`; then
7. another clean Wasmer directory restores the same generation, starts the
   exact unmodified Gateway, and a distinct official CLI guest completes its
   authenticated health RPC with `memory-core` and `ollama` loaded.

The combined evidence requires the database SHA-256, generation ID, manifest
SHA-256, directory count, file count, and payload byte count to match on both
sides of the browser restart. The restored Gateway must consume that exact
generation; re-running package lifecycle hooks is forbidden. This closes the
fresh-browser state-recovery gate for the pinned release. Live authorized model
inference over TLS is proven by a separate browser lane in the same source-build
workflow; an opaque provider-credential broker remains a separate security
gate.
