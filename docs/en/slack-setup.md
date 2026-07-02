[日本語](../slack-setup.md) | **English**

# Slack App Setup Guide

Step-by-step instructions to create a Slack App for using xangi on Slack.

## 1. Access the Slack API

https://api.slack.com/apps

Log in with your Slack account.

## 2. Create a New App

1. Click **"Create New App"**
2. Select **"From scratch"**
3. App Name: `xangi` (or any name you prefer)
4. Select your workspace
5. Click **"Create App"**

## 3. Enable Socket Mode (Important)

xangi operates in Socket Mode (no Webhook required).

1. Click **"Socket Mode"** in the left menu
2. Turn **"Enable Socket Mode"** ON
3. Create an App-Level Token:
   - Token Name: `xangi-socket`
   - Scopes: `connections:write`
   - Click **"Generate"**
4. **Copy the displayed App Token (xapp-...)**

## 4. Event Subscriptions Settings

1. Click **"Event Subscriptions"** in the left menu
2. Turn **"Enable Events"** ON
3. Under **"Subscribe to bot events"**, add the following:

| Event | Description | Purpose |
|-------|-------------|---------|
| `app_mention` | When the bot is mentioned | Required |
| `message.im` | When a DM is received | For DM support |
| `message.channels` | Messages in public channels | For responding without mentions |
| `message.groups` | Messages in private channels | For responding without mentions |

> **Warning**: `message.channels` / `message.groups` are required if you use `SLACK_AUTO_REPLY_CHANNELS`

## 5. OAuth & Permissions Settings

1. Click **"OAuth & Permissions"** in the left menu
2. Under **"Scopes"** → **"Bot Token Scopes"**, add the following:

| Scope | Description | Purpose |
|-------|-------------|---------|
| `app_mentions:read` | Read mentions | Required |
| `chat:write` | Send messages | Required |
| `files:read` | Read files | For file attachment support |
| `reactions:write` | Add reactions (e.g. eyes emoji) | Required |
| `im:history` | Read DM history | For DM support |
| `im:read` | Read DMs | For DM support |
| `im:write` | Send DMs | For DM support |
| `channels:read` | Read public channel information | For `xangi-cmd slack_channels` |
| `groups:read` | Read private channel information | For `xangi-cmd slack_channels` |
| `channels:history` | Read public channel history | For responding without mentions |
| `groups:history` | Read private channel history | For responding without mentions |

## 6. Register Slash Commands (Optional)

1. Click **"Slash Commands"** in the left menu
2. Create the following commands:

| Command | Description |
|---------|-------------|
| `/new` | Start a new session |
| `/skills` | List available skills |
| `/skill` | Run a skill (Usage Hint: `<skill-name> [args]`) |

> **Note**: Request URL is not needed in Socket Mode.

## 7. Install to Workspace

1. Click **"Install App"** in the left menu
2. Click **"Install to Workspace"**
3. Review permissions and click **"Allow"**
4. **Copy the displayed Bot User OAuth Token (xoxb-...)**

## 8. Set Environment Variables

```bash
# Edit .env
vim .env
```

```bash
# Slack Bot Token (xoxb-...)
SLACK_BOT_TOKEN=xoxb-your-bot-token

# Slack App Token (xapp-...) for Socket Mode
SLACK_APP_TOKEN=xapp-your-app-token

# Allowed user ID (Slack User ID)
SLACK_ALLOWED_USER=U01234567

# Optional: Post replies directly in specific channels instead of threads
SLACK_REPLY_IN_CHANNELS=C01234567
```

> **Warning**: If you're only using Slack, remove (or comment out) `DISCORD_TOKEN` from `.env`.
> If `DISCORD_TOKEN` is set, Discord-side settings (`DISCORD_ALLOWED_USER`, etc.) will also be required.

## 9. Verify It Works

```bash
# Build
npm run build

# Start with Docker
docker compose up -d --build

# Check logs
docker logs -f xangi
```

Try the following in Slack:
- Mention the bot: `@xangi Hello!`
- Send a DM
- `/new` command
- `/skills` command

## How to Find IDs

### User ID

1. Open the user's profile
2. Click **"..."** (More) → **"Copy member ID"**

### Channel ID

**Method 1:** From the link
1. Right-click the channel name → **"Copy link"**
2. The channel ID is at the end of the URL: `https://xxx.slack.com/archives/C01234567` — `C01234567` is the ID

**Method 2:** From channel info
1. Open the channel → Click the channel name
2. The **Channel ID** is displayed at the bottom

## Troubleshooting

### Bot Doesn't Respond

1. Verify Socket Mode is enabled
2. Verify `app_mention` and `message.im` are set in Event Subscriptions
3. Verify the bot has been invited to the channel (`/invite @xangi`)
4. Verify `SLACK_ALLOWED_USER` is set to the correct Slack User ID

### Slash Commands Don't Work

1. Verify the commands are registered in Slash Commands
2. Reinstall the app (required after permission changes)

### "Slack tokens not configured" Error

Verify that `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` are set in `.env`.

### Bot Doesn't Respond in DMs

1. Verify `im:history` and `im:read` are in OAuth Scopes
2. Verify `message.im` is set in Event Subscriptions

## Inviting the Bot to a Channel

To use the bot in a channel, you need to invite it:

```
/invite @xangi
```

## Security Notes

- **Never commit tokens to Git** (`.env` is already in `.gitignore`)
- **Never expose tokens publicly** (regenerate in Slack App settings if leaked)
- `SLACK_ALLOWED_USER` restricts usage to a single user (in compliance with Claude Code Terms of Service)

## References

- [Slack API Documentation](https://api.slack.com/docs)
- [Bolt for JavaScript](https://slack.dev/bolt-js/)
- [Socket Mode](https://api.slack.com/apis/connections/socket)
