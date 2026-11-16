[日本語](../extension-development.md) | English

# Extension design principles and development guide

This guide helps people and AI develop xangi extensions. Choose designs, implementation languages, and templates to suit the task and user preferences. Follow the implemented contracts for manifests, readiness, and authentication.

For consistent UI density, use the [recommended typography roles](extension-ui.md#recommended-ui-typography-and-density) and the bundled template CSS variables.

## What is an extension?

An extension adds specialized UI, data operations, or device connections to xangi. In the managed HTTP model, a manifest declares its entry point, and the host starts a separate process and proxies its UI and APIs.

- **Skills** provide procedures and decision criteria for AI when existing tools can meet the goal.
- **Extensions** provide dedicated APIs or ongoing services. They can include skills explaining their use.
- **Ordinary applications** can also act as extensions by adding an integration entry point. Registration provides host-managed startup, diagnostics, and authenticated forwarding.

Combine UI, AI, devices, storage, external services, and ongoing processing as needed. Reading notes can start with UI and storage; a sensor integration can start with device input and collection.

## Developing with AI

### Development-command entry point

The user describes the desired capability, and the conversational AI reads `extension create` output and continues development. This command returns the development guide and template publication target; it does not create files or start another AI. `--help` displays usage only. In a development checkout, it also displays the local template path and README.

### Create from the template

Start a new extension from the requested template or the latest published template. AI reads its README and setup instructions, then handles acquisition, configuration, and verification. When GitHub repository creation is part of the request, use the CLI below and adjust the owner, name, and visibility accordingly.

For new extensions, use the `xangi-xxx` form for the repository name, extension ID, and display name (for example, `xangi-counter`). Keep the display name consistent instead of shortening it to `Counter`, so the extension remains recognizable. This is a recommendation; user preferences and existing product names take precedence. Do not rename existing IDs solely to follow it, because IDs affect storage, settings, and capabilities. Prefer `xs-xxx` for skill names (for example, `xs-counter` for the `xangi-counter` extension). Skill names are separate from extension IDs. User preferences and existing skill names take precedence; installed skills are not automatically renamed, moved, or deleted.

```sh
gh repo create OWNER/xangi-example --template karaage0703/xangi-extension-template --private --clone
cd xangi-example
npm ci
npm run configure -- --id xangi-example --name xangi-example --features ui
npm test
npm run build
```

For local-only work, copy the template into a separate development directory. Reuse its configuration, startup, authentication, update preparation, and documentation when adding domain features. Work in the existing project when modifying an extension.

The template is a Node.js standard-library reference. Select features from `ui,device,ai`; UI alone is the default, and `none` disables all three. Configuration generates the manifest. The device example provides authenticated message ingress; hardware SDKs, `agentBackend`, and composer UI require their own implementation.

### Implementation and verification

1. Define the first input and result, exclusions, and success criteria. Inspect existing code, docs, tests, and settings, including the [host design](design.md) and the extension's README and setup document.
2. Choose the repository and branch and isolate existing uncommitted changes.
3. Implement the manifest, entrypoint, APIs, required UI, and documentation. Compare changes with the template and check configuration/manifest agreement.
4. Read [Extension Integration](usage.md#extension-integration) and help through the target instance's absolute CLI. Within the requested scope, register the extension, start only its ID, and check `status` and `doctor`.
5. Verify a representative operation through its API, UI, and stored data. Cover failures, timeout, cancellation, and restart retention as needed for the change.
6. Report changes, checks, unknowns, compatibility, and data impact. Publish or send externally only within the authorized scope.

### Adapt documentation to the extension

The README describes capabilities, quickstart, and links to details. Refer to host documentation for shared integration contracts; maintain extension-specific settings, operation, and storage documentation in the extension repository. Keep Japanese and English versions aligned.

| Content                                   | Japanese         | English             |
| ----------------------------------------- | ---------------- | ------------------- |
| Capabilities and quickstart               | `README.md`      | `README.en.md`      |
| AI-guided setup                           | `XANGI_SETUP.md` | `XANGI_SETUP.en.md` |
| Configuration, usage, and verification    | `docs/usage.md`  | `docs/en/usage.md`  |
| Architecture, authentication, and storage | `docs/design.md` | `docs/en/design.md` |

This is the template layout. Follow the existing project's documentation structure when modifying an extension.

## Host, extension, and skill responsibilities

| Owner          | Responsibility                                                                |
| -------------- | ----------------------------------------------------------------------------- |
| xangi host     | Conversations, agents, execution state, extension lifecycle, and shared proxy |
| Extension      | Domain data, APIs, specialized UI, processing, and device connections         |
| Skill          | AI-facing procedures, decision criteria, and tool instructions                |
| User workspace | User-specific rules, destinations, and integration settings                   |

- Provide stable IDs and APIs so screens and conversations use the same data.
- Use code for persistence, validation, and state updates; use AI for interpreting intent and generating text.
- Search the host, existing extensions, and skills before introducing another mechanism.
- Distinguish startup, readiness, generation, persistence, and external delivery when reporting observed results.
- Keep personal paths, hosts, credentials, conversation IDs, and private data out of distributable resources.

## AI execution policy

Consider host-mediated execution first when no route is specified. Distinguish continuing a conversation from submitting a unit of work and use an existing API that fits. Explain the agent, destination, result, errors, timeout, cancellation, and available history and usage.

Use an explicitly selected agent or the default resolved by the host, and show the effective value. Do not duplicate the host's selection rules or silently borrow another extension's agent. Report a configuration problem if resolution fails.

The normal destination is the parent instance. Connections to another instance or directly to AI require explicit configuration. Show the destination, authentication, timeout, cancellation, and coverage of host stopping, monitoring, history, and usage records. Do not invent usage that the backend does not return. Inspect and preserve execution routes, agents, and destinations when migrating existing extensions.

## Current managed HTTP interfaces (implementation reference)

### Manifest

Declare a relative entrypoint, runtime, and HTTP capability in `xangi-extension.json` at the repository root. Implement the corresponding script and HTTP service as well.

```json
{
  "schemaVersion": 2,
  "id": "xangi-example",
  "displayName": "xangi-example",
  "version": "0.1.0",
  "entrypoint": "scripts/xangi-extension",
  "runtime": { "kind": "managed-http" },
  "setup": { "instructions": "XANGI_SETUP.md" },
  "capabilities": [{ "id": "xangi-example.manage", "protocol": "http", "healthPath": "/health" }],
  "ui": { "capability": "xangi-example.manage", "path": "/ui" }
}
```

`setup` and `ui` are optional. See `ExtensionManifest` and `parseExtensionManifest()` for declarations and validation.

### Startup, status, and shutdown

1. The host starts the entrypoint with `serve --workspace <path>` and supplies `XANGI_EXTENSION_AUTH_TOKEN`.
2. The extension listens on an automatically allocated `127.0.0.1` port and checks the bearer token on incoming requests.
3. Emit readiness JSON as one stdout line and write diagnostics to stderr. Use the actual workspace and URL.
4. Shut down the service and work on stdin EOF, SIGTERM, or SIGINT.

```json
{
  "schemaVersion": 2,
  "event": "ready",
  "id": "xangi-example",
  "workspace": "/absolute/path/to/workspace",
  "baseUrl": "http://127.0.0.1:12345"
}
```

The host validates identity, workspace, and loopback URL and distinguishes `running`, `healthy`, and `ready`. A pending cold-start health check does not immediately fail a process whose readiness was validated. See [Extension Integration](usage.md#extension-integration) for details.

The parent supplies `XANGI_EXTENSION_INSTANCE_ID`, plus `XANGI_EXTENSION_HOST_URL` when Web Chat is enabled and `XANGI_EXTENSION_EVENTS_URL` when event delivery is enabled. Use the supplied values rather than guessing the parent's URL or port.

### UI, authentication, and trust boundaries

The UI entry is `/api/extensions/<id>/ui`; the service entry is `/api/extensions/<id>/service/`. Use relative asset, API, and WebSocket URLs that work under the host path. See [Extension Integration](usage.md#extension-integration) for proxy authentication, cookies, redirects, and limits.

Use the [extension UI guide](extension-ui.md) for shared Home, Back/Forward, and theme integration, and provide domain operations in the extension. Host Back/Forward traverse browser history including iframe entries. Extensions can provide custom navigation when needed, such as checking unsaved changes.

The extension-service bearer and host API authentication are separate. Do not reuse the service token for host API calls or expose it to the browser, manifest, or logs.

Extensions run trusted local code and inherit the parent's environment during managed startup. `permissions` is descriptive; separate processes and iframes do not guarantee OS-level privilege isolation.

### Setup, data, and updates

The setup document covers connections, storage, agents, optional features, and verification. Install bundled skills according to the destination workspace's conventions, comparing existing skills with the same name.

Keep persistent data outside source directories replaced during updates. Explain workspace/instance scope, destination resolution, backup and restore, and retention after updates and unlinking. Check actual storage locations for each extension.

Repository-managed updates require `update.prepare` and matching source-management state. Separate the preparation program from its arguments and check `doctor` and data retention after updates. Treat source updates, workspace skill updates, unlinking, and data deletion as distinct operations. See [Extension Integration](usage.md#extension-integration) for update and recovery behavior.

## AI-led configuration, customization, and migration

AI handles investigation, configuration, migration, startup, verification, and recovery according to the user's goals and preferences. Proceed where the request provides enough context; ask about missing goals or changes beyond its scope.

Describe setting meanings, defaults, allowed values, apply timing, and storage scope, and make effective values readable. Store user preferences in destination settings rather than generic defaults or another instance. Use existing secret storage or environment variables and omit secret values from reports.

Choose suitable existing APIs, CLIs, copying, or conversion tools for migration, and verify:

- Ownership, scope, source, destination, and pre-migration backup and restoration procedures.
- Preservation of content, IDs, references, settings, and preferences, including mappings for format changes.
- Counts, content, references, read-back, representative operations, and restart retention.

An empty successful startup or passing `doctor` is insufficient migration evidence. Keep originals and a restoration path until comparison is complete.

## Compatibility verification

Document required host features and APIs, the tested host version, and unknowns in the extension's setup document. Distinguish unit/mock tests from real-host verification. Manifest `schemaVersion` identifies its format; the current manifest has no shared field for machine-checking a supported host version range.

## Implementation references

- [Manifest and managed runtime](../../src/extensions.ts): types, parsing, readiness, status, and process management.
- [Service proxy](../../src/extension-web-proxy.ts) and [UI](../../web-ui/src/ExtensionView.tsx): authenticated forwarding and host display.
- [Catalog, setup, and removal](../../src/extension-catalog.ts), [repository acquisition](../../src/extension-repository.ts), and [updates](../../src/extension-update.ts): acquisition, setup, retention, and recovery.
- [AI requests](../../src/web-chat.ts): conversation and agent-run APIs.
- [Runtime tests](../../tests/extensions.test.ts), [proxy tests](../../tests/extension-web-proxy.test.ts), and [update tests](../../tests/extension-update.test.ts): contracts and failure behavior.
