# North Star

## Ultimate objective

Run one exact, officially published OpenClaw release, unchanged, entirely
inside a standards-based web browser on an open-source, self-hostable kernel —
persistently, securely, and with reproducible public proof of a real
Gateway-backed agent turn — without a proprietary execution substrate or a
remote operating system.

OpenClaw execution must be browser-local. User-authorized model providers,
channels, and other network services may be remote, but no remote machine may
host OpenClaw or supply its Node-compatible execution environment.

## Definition of done

The objective is complete only when a reproducible browser test can:

1. fetch one exact, officially published OpenClaw artifact and verify its
   identity and integrity;
2. install that artifact and its required dependency graph, including required
   lifecycle scripts, without patching, rebuilding, or forking OpenClaw;
3. provide the Node APIs, process behavior, filesystem, database, networking,
   workers, and native-extension behavior reached by the tested OpenClaw
   release;
4. start the real OpenClaw Gateway and pass its readiness and health checks;
5. pair a real client and complete a real agent turn through a user-authorized
   model endpoint;
6. preserve the relevant OpenClaw state across Worker termination, page
   reload, and a fresh browser session;
7. keep credentials and ambient host authority outside the untrusted guest,
   exposing authority only through explicit, least-privilege, revocable
   capabilities;
8. publish version-bound evidence which another maintainer can independently
   reproduce from source.

Passing a synthetic agent, a compatibility mock, a partial boot, or a patched
OpenClaw build does not satisfy this definition.

For criterion 5, “pair a real client” means completing the authentication flow
native to the demonstrated official client class. The official CLI uses
Gateway token authentication; node or control-UI clients use OpenClaw device
pairing and must complete that flow when they are the tested client. The audit
must not substitute one client class's pairing record for another class's real
authentication.

## Constraints

- The kernel and every mandatory runtime component must be open source and
  independently self-hostable.
- BrowserPod, a remote VM, a remote container, or another proprietary compute
  service may be used for comparison, but never to satisfy the execution path.
- Unsupported authority must fail explicitly. Compatibility claims may not be
  inferred from API presence or a partial boot.
- The implementation may optimize for one current desktop browser first, but
  the architecture must rely on documented web-platform capabilities rather
  than a vendor-hosted runtime.

## Replaceable means

Edge.js, Wasmer, WASI/WASIX, SQLite Wasm, OPFS, and any JavaScript engine are
candidate implementation components, not the objective. They may be replaced
whenever another design reaches the definition of done more directly.

The existing `node:sqlite`, Edge.js, and package-image experiments are proven
kernel milestones, not commitments to the final runtime architecture and not
alternate definitions of success.
