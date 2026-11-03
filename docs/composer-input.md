# Composer input extensions

Installed, running, healthy extensions declaring `composer.input` can contribute text to the Web Chat draft.
The official catalog includes [xangi-voice-input](https://github.com/airpocket-soundman/xangi-voice-input).
It uses Google Chrome's speech recognition for Japanese input; remote use assumes Tailscale Serve HTTPS.
Installation, microphone permissions, and optional HTTPS setup are described in the extension repository.
Xangi itself does not run a speech recognition engine or receive audio.

## Protocol

Xangi loads `/api/extensions/<id>/service/composer/` in a same-origin iframe with microphone permission.
Every message uses `schemaVersion: 1`. Both sides must validate origin and source window.
Extensions announce `xangi.composer.ready`. Xangi responds with `xangi.composer.configure`,
containing a `contextId` and `disabled` flag. Extensions must cancel work when the context changes or they are disabled.

Extension messages include the current `contextId`:

| Message                       | Additional fields               | Purpose                                                                  |
| ----------------------------- | ------------------------------- | ------------------------------------------------------------------------ |
| `xangi.composer.availability` | `message`                       | Explain availability, including HTTP or browser limitations.             |
| `xangi.composer.begin`        | `requestId`                     | Start one input operation; sending is disabled until it ends.            |
| `xangi.composer.update`       | `requestId`, `revision`, `text` | Supply the entire recognized utterance, replacing its previous snapshot. |
| `xangi.composer.status`       | `requestId`, `message`          | Show interim progress without changing the draft.                        |
| `xangi.composer.end`          | `requestId`, optional `error`   | End the operation and restore normal sending.                            |

Revisions must be increasing safe integers. Request IDs are nonempty strings of at most 100 characters;
text snapshots are nonblank strings of at most 100,000 characters. Status messages are limited to 1,000 characters.
Only one extension operation is active at a time. Context changes invalidate late results.
Typing, switching conversations or inactive panes, hiding the page, or removing an extension cancels its operation.
The first snapshot is appended to the draft with a newline if needed; subsequent snapshots replace the earlier suffix.
If that suffix has been manually edited, subsequent updates do not overwrite the draft.
Extensions do not receive a send capability, and results do not automatically focus the textarea.

The iframe is intended for trusted installed extensions. Same-origin extension code is not isolated from the host as untrusted code.

## Validation

Run `npm run typecheck` and `npx vitest run tests/composer-extensions.test.ts tests/extension-catalog.test.ts`.
The extension repository also provides browser tests against the actual ChatPane using a mock recognition engine.
Set its `XANGI_CORE_PATH` to this checkout and `XANGI_TEST_CHROMIUM` to a Chromium executable.
