# LINE Messaging API Setup Guide

How to run xangi as a LINE bot. Designed for 1:1 chat.

## 1. Create a Messaging API channel

Log in to <https://developers.line.biz/> with your LINE account, then:

1. Create a provider if you don't have one (any name, e.g. `xangi`).
2. From the provider page, click **Create a new channel** → choose **Messaging API**.
3. Fill in channel info (Channel name, description, region: Japan, etc.) and create.

## 2. Get channel secret and access token

In the new channel's settings:

- **Basic settings** tab:
  - Copy **Channel secret** → `LINE_CHANNEL_SECRET`
- **Messaging API** tab:
  - Issue **Channel access token (long-lived)** and copy it → `LINE_CHANNEL_ACCESS_TOKEN`

## 3. Webhook & response settings

In the **Messaging API** tab (lower section):

- **Webhook URL**: leave empty for now. After exposing the bot via Tailscale Funnel / Cloudflare Tunnel, set `https://<host>/webhook` (match `LINE_WEBHOOK_PATH`).
- **Use webhook**: ON.
- **Auto-reply messages**: disable in **LINE Official Account Manager** (so xangi handles replies).
- **Greeting messages**: optional.

## 4. Configure `.env`

```bash
LINE_CHANNEL_ACCESS_TOKEN=<token from step 2>
LINE_CHANNEL_SECRET=<secret from step 2>
LINE_ALLOWED_USER=<LINE userId(s), comma-separated, or "*" for all>
# Optional: webhook
LINE_WEBHOOK_PORT=8765
LINE_WEBHOOK_PATH=/webhook
# Optional: UX (responsiveness)
LINE_LOADING_ANIMATION_ENABLED=true       # show "typing…" right after webhook
LINE_LOADING_ANIMATION_SECONDS=60         # one of 5/10/15/20/25/30/40/50/60
LINE_SLOW_RESPONSE_ENABLED=true           # reply→push auto-switch after slow threshold
LINE_SLOW_RESPONSE_THRESHOLD_MS=45000     # threshold for "still thinking" notice + Push fallback
# Optional: Session boundaries (time-based + commands)
LINE_IDLE_RESET_ENABLED=true              # auto-switch session after idle period
LINE_IDLE_RESET_HOURS=4                   # idle threshold in hours (decimal allowed, 0 disables)
# LINE_RESET_TEXT_PATTERNS=/reset,リセット,最初から,はじめから   # override default patterns
```

LINE userId starts with `U` (33 chars). When a non-allowed user messages the bot, xangi logs `[xangi-line] user Uxxxx... not in allowlist, ignoring`. Copy that ID into `LINE_ALLOWED_USER` and restart.

## 5. Public endpoint (Tailscale Funnel example)

LINE webhooks require a public HTTPS URL. Tailscale Funnel is the easiest:

```bash
tailscale funnel --bg 8765
```

The Funnel URL (`https://<machine>.<tailnet>.ts.net/`) plus `LINE_WEBHOOK_PATH` (default `/webhook`) becomes the webhook URL. Register it in the LINE Developers console and click **Verify** → expect `Success`.

Alternatively, `cloudflared tunnel --url http://localhost:8765` works the same way.

## 6. Start and test

```bash
npm run build
npm start
```

Look for `[xangi-line] webhook listening on port 8765, path /webhook` in the startup log.

Add the LINE official account as a friend via the QR code (under **Messaging API** tab), send a message, and xangi will reply.

## Security

- LINE webhooks are signed with HMAC-SHA256 in the `X-Line-Signature` header; `@line/bot-sdk`'s `validateSignature` verifies it automatically — without the Channel secret, no valid signature can be forged.
- Avoid `*` in `LINE_ALLOWED_USER` for 1:1 use cases; restrict to specific userIds.
- Keep the channel access token and secret out of git (`.env` is gitignored).

## Responsiveness & context UX

LINE has no Slack-style threads or Discord-style "new chat" buttons, and reply tokens expire in 60s. To avoid silent failures, xangi uses two layers of fallback:

### 1. Instant ACK — Loading animation (default ON)

Right after the webhook is received and before the runner starts, xangi calls LINE's official Loading animation API (`POST /v2/bot/chat/loading/start`) to display "typing…" in the chat. The animation disappears automatically when the bot sends its next message. DM-only (groups/rooms are ignored by LINE, but the API call still succeeds).

- `LINE_LOADING_ANIMATION_ENABLED=false` disables it.
- `LINE_LOADING_ANIMATION_SECONDS` (default `60`) — valid values are `5/10/15/20/25/30/40/50/60`; out-of-range values are snapped to the nearest valid value.

### 2. Reply→Push fallback — Slow response (default ON)

LINE reply tokens expire 60s after the inbound event. If a response is going to take longer, xangi:

1. Sends `🤔 ちょっと待ってね、考えてる…` via the reply token at `LINE_SLOW_RESPONSE_THRESHOLD_MS` (default `45000` = 45s), consuming the token.
2. Sends the actual response via the Push API (`POST /v2/bot/message/push`) once the runner finishes.

This keeps long-running conversations alive past 60s. `LINE_SLOW_RESPONSE_ENABLED=false` disables it (not recommended — responses over 60s would be lost).

The Push API is free for the first 200 messages per month on personal Official Accounts; usage above the quota is billed. If you regularly trigger slow responses with a local LLM (Gemma, etc.), consider increasing the threshold or using a faster backend.

## Session boundaries (when to clear context)

LINE has no explicit conversation boundaries like Slack's threads or Discord's "new chat" button. If every message reuses the same session forever, the context window bloats and topics get tangled. xangi uses a two-layer approach to start fresh sessions:

### 1. Idle session reset (default ON, 4h)

When the next message arrives after `LINE_IDLE_RESET_HOURS` (default `4`) of inactivity, the active session is archived via `archiveSession()` and a new one is created. The conversation history in `logs/sessions/<sessionId>.jsonl` is preserved, so nothing is truly lost.

- Kids' conversations naturally cluster around school / sleep / meal patterns at multi-hour intervals — 4 h is a good cut.
- Decimal values supported (`LINE_IDLE_RESET_HOURS=0.5` for 30 minutes, handy for testing).
- `LINE_IDLE_RESET_ENABLED=false` disables it entirely (single endless session).

### 2. Reset-command detection (default ON, 3 slash commands)

If a user sends text matching the reset patterns exactly, the runner is skipped, the active session is archived + replaced, and the bot immediately replies "最初からお話するね！何かあった？".

- Default patterns: `/reset` `/new` `/clear` only (unambiguous slash format)
- Idle reset (time-based) is the primary boundary; commands are a manual escape hatch, so the default set is intentionally minimal.
- Case-insensitive, whitespace stripped, exact match only (substrings like "/reset please" do not fire).
- Japanese natural-language phrases (`リセット`, `最初から`, `やり直し`, etc.) are excluded from defaults because the boundary against neighboring phrases ("リセットってどういう意味？", "最初からお話したい") is fuzzy. Add them explicitly via CSV if needed: `LINE_RESET_TEXT_PATTERNS=/reset,/new,/clear,リセット,最初から`
- Empty string disables detection: `LINE_RESET_TEXT_PATTERNS=`

### Rich Menu integration (recommended)

LINE bots can pin a Rich Menu (image + bound buttons) to the chat. Bind buttons like "Reset" / "Help" / "Tell mom" to send text payloads (e.g. `リセット`, `ヘルプ`) and the reset-command detector picks them up naturally. Rich Menu setup is documented separately (TBD).
