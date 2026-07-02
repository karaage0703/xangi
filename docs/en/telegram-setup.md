# Telegram Bot Setup Guide

How to run xangi as a Telegram bot.

## 1. Create a bot with BotFather

Open [@BotFather](https://t.me/BotFather) in Telegram and send:

```
/newbot
```

1. Enter a display name for the bot (e.g. `xangi`)
2. Enter a username — must end in `bot` (e.g. `xangi_bot`)
3. Copy the **API token** shown in the response

```
Use this token to access the HTTP API:
<API token issued by BotFather>
```

⚠️ **Keep this token secret.** It grants full control over your bot.

## 2. Configure Bot Settings (important)

In BotFather, send `/mybots` → select your bot → **Bot Settings**.

### Allow Groups

Required if you plan to add xangi to group chats.

**Bot Settings → Allow Groups → Enable**

### Group Privacy

Default is Privacy ON, which means the bot only receives messages that mention it, reply to it, or start with a bot command. To let xangi respond to messages without a mention (used with `TELEGRAM_AUTO_REPLY_CHATS`), turn this off.

**Bot Settings → Group Privacy → Turn off**

> With Privacy ON, Telegram filters out non-mention messages at the server level before they reach your bot. If you only use xangi in DMs, no change is needed.

### Bot to Bot Communication

Required when using `TELEGRAM_ALLOWED_BOTS` to have xangi collaborate with other bots. Disabled by default, so bots cannot send messages to each other.

**Bot Settings → Bot to Bot Communication → Enable**

> Without this, messages sent by other bots will not be delivered to xangi, even if those bot IDs are listed in `TELEGRAM_ALLOWED_BOTS`.

## 3. Find user and chat IDs

### Your numeric user ID

Send any message to [@userinfobot](https://t.me/userinfobot) and it replies with your ID:

```
Your ID: 123456789
```

Add this value to `TELEGRAM_ALLOWED_USER`.

### Group chat ID

Start xangi, then send a message in the target group. The chat ID appears in the log:

```
[xangi-telegram] group chat detected: -1001234567890
```

Add this value to `TELEGRAM_ALLOWED_CHATS`. Group IDs are typically negative (e.g. `-1001234567890`).

### Allowed bot IDs

Forward a message from the target bot to [@userinfobot](https://t.me/userinfobot), or read the ID from xangi's logs. Add the numeric ID to `TELEGRAM_ALLOWED_BOTS`.

## 4. Configure xangi `.env`

```bash
TELEGRAM_BOT_TOKEN=<API token issued by BotFather>

# Allowed users (numeric Telegram user IDs, CSV). Use "*" to allow everyone.
TELEGRAM_ALLOWED_USER=123456789,987654321

# Optional: group settings
TELEGRAM_ALLOWED_CHATS=-1001234567890        # Chat IDs to process (CSV)
TELEGRAM_AUTO_REPLY_CHATS=-1001234567890     # Groups where no mention is needed (CSV)

# Optional: allowed bots (numeric bot user IDs, CSV)
TELEGRAM_ALLOWED_BOTS=555000001,555000002
TELEGRAM_ALLOWED_BOTS_MAX_CONSECUTIVE=3      # Max mentions from the same bot within 5 minutes

# Optional: startup mode (polling is the default)
TELEGRAM_MODE=polling                        # polling | webhook
# TELEGRAM_FORCE_IPV4=true                  # only when the IPv6 route times out

# Required when using webhook mode:
# TELEGRAM_WEBHOOK_URL=https://your-host.example.com  # public URL used to register the webhook with Telegram
# TELEGRAM_WEBHOOK_SECRET_TOKEN=your-long-random-secret  # rejects requests that don't carry this token

# Optional: webhook server settings
# TELEGRAM_WEBHOOK_PORT=8766                # listening port (default: 8766)
# TELEGRAM_WEBHOOK_PATH=/telegram/webhook  # path (default; leading slash is optional)

# Optional: response display
TELEGRAM_STREAMING=true
TELEGRAM_SHOW_THINKING=true

# Optional: session boundaries
TELEGRAM_IDLE_RESET_ENABLED=true
TELEGRAM_IDLE_RESET_HOURS=4
# TELEGRAM_RESET_TEXT_PATTERNS=/reset,/new,/clear  # override only if needed
```

## 5. Start and verify

```bash
npm run build
npm start
```

You should see:

```
[xangi-telegram] Ready! Logged in as @xangi_bot (7123456789)
[xangi-telegram] Starting bot with long polling...
```

Send a DM to your bot from Telegram. If xangi responds, the setup is complete.

### Adding the bot to a group

1. Open the group → Add member → search for `@xangi_bot`
2. Admin permissions are not required (send/receive messages only)
3. Mention the bot in the group: `@xangi_bot hello`

Verify that the target chat ID appears in the startup log under `Allowed group chats`. When a mention is ignored, the log reports whether the chat and sender passed their allowlists, which identifies a mismatch in `TELEGRAM_ALLOWED_CHATS` or `TELEGRAM_ALLOWED_USER`. For replies without a mention, disable Group Privacy in BotFather and add the chat ID to `TELEGRAM_AUTO_REPLY_CHATS`.

In groups, xangi posts the initial processing message and edits it once with the final answer; it does not publish intermediate streaming updates. It also ignores messages containing a mention of another bot username (a username ending in `bot`). In groups, messages from an allowed bot are processed only when they explicitly mention xangi; replies and unmentioned bot messages are ignored. Loop counters are scoped by group chat ID and sender bot ID, expire after five minutes, and reset on any human message in that group even when the message is otherwise ignored. xangi's own posts, scheduled posts, and DMs do not increment these counters.

## 6. Security

- Store `TELEGRAM_BOT_TOKEN` in `.env` and never commit it (`.env` is in `.gitignore`)
- Avoid `*` for `TELEGRAM_ALLOWED_USER` in shared or public environments
- `TELEGRAM_ALLOWED_BOTS` requires explicit numeric IDs; wildcard `*` is not supported
- Set `TELEGRAM_ALLOWED_CHATS` to restrict xangi to specific groups

## 7. Minimal setup for DM-only use

If you only need 1:1 DMs, this is all you need:

```bash
TELEGRAM_BOT_TOKEN=<API token issued by BotFather>
TELEGRAM_ALLOWED_USER=123456789
```

No changes to Group Privacy, Allow Groups, or Bot to Bot Communication are needed.

## 8. Commands

| Command                  | Action                                         |
| ------------------------ | ---------------------------------------------- |
| `/new` `/reset` `/clear` | Reset the session and start a new conversation |
| `/stop`                  | Stop the currently running task                |
| `/help`                  | Show usage instructions                        |

## 9. Telegram API connection timeouts

If you see `ETIMEDOUT` or `Network request for 'getMe' failed`, test the route from the Raspberry Pi:

```bash
curl -4 --connect-timeout 10 -I https://api.telegram.org
curl -6 --connect-timeout 10 -I https://api.telegram.org
```

If IPv4 succeeds but IPv6 times out, add this to `.env` and restart xangi:

```bash
TELEGRAM_FORCE_IPV4=true
```

xangi retries temporary DNS, connection, and Telegram API failures in the background, so other chat platforms continue starting normally. Authentication errors are not retried.

An `editMessageText` timeout is ambiguous: Telegram may have applied the edit even though its response did not reach xangi. xangi retries only the edit of the same message ID and never falls back to a new message. If delivery remains uncertain, it suppresses a new send to prioritize avoiding duplicate responses.

Telegram errors can contain the Bot API URL. xangi redacts the token before logging these errors. If a token appeared in an older log, revoke it with BotFather's `/revoke` command and issue a new one.

## 10. `409 Conflict`

This means that multiple long-polling processes are using the same bot token. The Telegram Bot API permits only one long-polling process per token.

```bash
pm2 list
pm2 describe xangi
pgrep -af 'dist/index.js|xangi'
```

Use PM2 in `fork` mode with `instances: 1`, and check for manually started, systemd, Docker, or other-machine instances using the same bot. xangi stops only Telegram polling when it detects a 409, preventing an endless conflict loop. After stopping the duplicate process, restart the xangi instance that should own the bot.
