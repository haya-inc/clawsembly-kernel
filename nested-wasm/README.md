# Browser-local nested WebAssembly

This crate produces a `wasm32-unknown-unknown` static archive containing the
OSS [Wasmi](https://github.com/wasmi-labs/wasmi) WebAssembly C API. The archive
is linked into the Edge.js WASIX guest, so QuickJS can expose the standard
JavaScript `WebAssembly` global without importing a native host runtime.

The crate is deliberately `no_std`. Its allocator delegates to the WASIX
libc already linked by Edge.js. The pinned C API implementation is built
without default features and interprets child WebAssembly modules inside the
browser guest. CI compiles the archive with the `atomics`, `bulk-memory`, and
`mutable-globals` target features required by Edge.js's shared-memory WASIX
link.

This is an execution compatibility layer, not a capability grant. Nested
modules inherit only the imports explicitly supplied by JavaScript and do not
receive filesystem, network, or browser access by default.

`link-smoke.rs` is compiled separately and linked against the archive in CI.
`run-link-smoke.mjs` then instantiates that linked module and calls
`wasm_engine_new`/`wasm_engine_delete`, proving that the standard C API symbols
are not merely present as archive strings but are linkable and executable.
