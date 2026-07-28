# OpenClaw install lifecycle contract

Clawsembly distinguishes a declared package-manager hook from an effect that
the pinned OpenClaw workload actually requires. The integrity-pinned package
graph contains four packages with lifecycle metadata:

| Package | Command | Browser-kernel disposition |
| --- | --- | --- |
| `openclaw@2026.7.1-2` | `node scripts/preinstall-package-manager-warning.mjs` | Execute the exact published script. It enforces the Node engine contract and completes the optional packed install guard. |
| `openclaw@2026.7.1-2` | `node scripts/postinstall-bundled-plugins.mjs` | Execute the exact published script. On a clean package image it leaves package files unchanged and migrates the installed plugin registry into OpenClaw's SQLite state. |
| `@google/genai@2.10.0` | `echo 'preinstall: no-op'` | Record as a source-proven no-effect hook. It has no filesystem or runtime effect to reproduce. |
| `protobufjs@7.6.3` | `node scripts/postinstall` | Execute the exact published script. In this graph it emits no warning and changes no state. |
| `tree-sitter-bash@0.25.1` | `node-gyp-build` | Do not authorize a native build. OpenClaw's source policy sets `tree-sitter-bash: false` in `allowBuilds`, and its command explainer loads the published `tree-sitter-bash.wasm` through `web-tree-sitter` rather than the `.node` binding. |

The native `tree-sitter-bash` hook is not merely unsupported on WASIX. It is
outside the required OpenClaw path and outside the authority granted to the
installer. The browser proof validates the exact published Wasm grammar before
accepting that disposition.

## Browser proof

`src/openclaw-install-lifecycle.ts` runs each required Node script as an
independent Edge.js process against one shared Wasmer `Directory`. The proof:

1. starts from the exact `ClawsemblyFS` image whose package and dependency
   archives were SRI-verified;
2. runs the two OpenClaw hooks and the `protobufjs` hook without changing their
   source;
3. rejects any clean-image dist prune or Baileys runtime patch;
4. requires the official postinstall to report 33 indexed plugins;
5. opens the resulting `state/openclaw.sqlite` from another Edge.js process;
6. requires the stored host contract `2026.7.1-2`, 33 plugins, migration
   version 1, and refresh reason `migration`; and
7. starts the real Gateway and agent-turn proof on that same installed
   filesystem state.

This closes the package lifecycle-effect requirement for the pinned release.
It does not claim arbitrary npm lifecycle compatibility, native addon ABI
support, or permission to run unreviewed package scripts. The
[OPFS directory-store proof](opfs-directory-store.md) commits the resulting
official state and recovers it after a complete browser restart without
re-running these hooks.
