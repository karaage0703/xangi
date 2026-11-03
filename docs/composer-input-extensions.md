# Composer input extensions (protocol v1)

An installed, running, healthy managed HTTP extension can declare the `composer.input`
capability and a UI in its schema-v2 manifest. The Web UI discovers it through the
existing `/api/extensions` catalog and embeds its `/composer/` service route in a
44 × 44 iframe next to each chat input. The catalog is refreshed every five seconds;
unavailable extensions are removed without blocking normal typing.

This convention needs no manifest schema, server endpoint, or extension lifecycle
changes. Existing extensions without this capability are unaffected. The voice
implementation lives separately in [xangi-voice-input](https://github.com/airpocket-soundman/xangi-voice-input),
including its recognition code, managed service, deployment notes and integration tests.

## Messages

All messages use `postMessage` to the exact same origin and include `schemaVersion: 1`.
Both sides validate the sender window and origin. The host sends
`xangi.composer.configure` with an opaque `contextId` and `disabled` boolean on load,
after `xangi.composer.ready`, and whenever the input context changes. The extension
must cancel its operation on context changes or when disabled.

The extension sends these message types:

| Type (prefix `xangi.composer.`) | Additional fields                            | Meaning                                                           |
| ------------------------------- | -------------------------------------------- | ----------------------------------------------------------------- |
| `ready`                         | —                                            | Request initial configuration                                     |
| `availability`                  | `contextId`, `message`                       | Explain unavailable input, such as HTTP or an unsupported browser |
| `begin`                         | `contextId`, `requestId`                     | Start one input operation                                         |
| `update`                        | `contextId`, `requestId`, `revision`, `text` | Replace that operation's full text snapshot                       |
| `status`                        | `contextId`, `requestId`, `message`          | Plain-text progress or interim recognition                        |
| `end`                           | `contextId`, `requestId`, optional `error`   | Finish and release the input                                      |

Only one operation per pane is accepted. Other contributions are disabled while it
is active. Revisions must be increasing positive safe integers. Snapshots are limited
to 100,000 characters; status/error messages to 1,000. The host preserves the preexisting
draft, replaces the previous snapshot rather than appending cumulative results, and
does not expose a send operation. Recording blocks submission. Manual edits, pane or
conversation changes, processing, backgrounding, removal, and iframe reload invalidate
old operations. Finishing rotates the context to reject replays.

The iframe receives no draft text, messages, agent credentials, or service bearer
token through this protocol. It receives microphone delegation so a direct button
click inside it can start browser recognition without opening the keyboard. These
are **trusted installed same-origin extensions**, not a sandbox for untrusted code:
same-origin frames can access the parent DOM independently of this protocol.

## Consumers and testing

[xangi-voice-input](https://github.com/airpocket-soundman/xangi-voice-input) is the
first consumer. Its supported remote setup is Tailscale Serve HTTPS; ordinary LAN
HTTP still allows typing. Microphone access requires a secure context, and browser
recognition support varies by OS. HTTPS configuration and voice recognition belong
to the extension deployment, not this core protocol. See the extension README for
installation and real-device testing.

The core contribution renders trusted installed extension UI and accepts text only.
It does not implement speech recognition, audio uploads, certificate management,
Tailscale installation, or a microphone button itself.

```sh
npm run typecheck
npx vitest run tests/composer-extensions.test.ts
XANGI_TEST_CHROMIUM=/path/to/chromium npm run test:browser:composer
```

The browser suite uses the real ChatPane and a test-only generic contribution iframe.
It checks snapshot replacement, sender/origin/context/request/revision validation,
manual cancellation, disabled submission, conversation changes, extension removal,
and mobile layout. No agent requests or actual message submissions are performed.
The voice repository runs its own integration suite against a compatible core
checkout through `XANGI_CORE_PATH`.
