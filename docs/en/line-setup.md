[日本語](../line-setup.md) | English

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

## 4. Set the tokens

```bash
xangi settings
```

Enter the Channel access token, Channel secret, and allowed user IDs in the LINE fields on the local settings page, then save them.

In a source checkout, the same allowed user IDs and other advanced settings can be placed in `.env`:

```bash
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

See the [Usage Guide](usage.md#platform-specific-message-handling) for runtime behavior such as images, response indicators, queued messages, and session boundaries.

## Security

- LINE webhooks are signed with HMAC-SHA256 in the `X-Line-Signature` header; `@line/bot-sdk`'s `validateSignature` verifies it automatically — without the Channel secret, no valid signature can be forged.
- Avoid `*` in `LINE_ALLOWED_USER` for 1:1 use cases; restrict to specific userIds.
- Store the channel access token and secret through `xangi settings`; never paste them into Git or an AI conversation.
