[日本語](../discord-setup.md) | English

# Discord Bot Setup Guide

Step-by-step instructions to create a Discord Bot for using xangi on Discord.

## 1. Access the Discord Developer Portal

https://discord.com/developers/applications

Log in with your Discord account.

## 2. Create a New Application

1. Click **"New Application"** in the top right
2. Enter a name: `xangi` (or any name you prefer)
3. Click **"Create"**

## 3. Create the Bot and Obtain the Token

1. Click **"Bot"** in the left menu
2. Click **"Reset Token"** → **"Yes, do it!"**
3. **Copy the displayed token** (you'll need it later)

> **Warning**: The token is only shown once. If you lose it, you'll need to regenerate it.

## 4. Bot Permission Settings (Important)

On the same Bot page, configure **Privileged Gateway Intents**:

| Intent                     | Required     | Description                 |
| -------------------------- | ------------ | --------------------------- |
| Presence Intent            | Optional     | Retrieve user online status |
| Server Members Intent      | Optional     | Retrieve server member info |
| **Message Content Intent** | **Required** | Read message content        |

**Warning: The bot cannot read messages unless Message Content Intent is turned ON!**

## 5. Invite the Bot to Your Server

1. Go to **"OAuth2"** → **"URL Generator"** in the left menu
2. Under **SCOPES**, select:
   - `bot`
   - `applications.commands` (for slash commands)
3. Under **BOT PERMISSIONS**, select:
   - Send Messages
   - Send Messages in Threads
   - Manage Threads (required when using the thread `Close` button to remove the user who clicked it)
   - Read Message History
   - Attach Files (required to send generated files)
   - Add Reactions
   - Use Slash Commands
4. Copy the generated URL
5. Open the URL in your browser and select the server to invite the bot to

## 6. Set the token

```bash
xangi settings
```

Paste the Bot token into the Discord field on the local settings page and save it. You do not need to paste the token into an AI conversation or `.env`.

### Dedicated Agent bots

The connection name is an optional management label. Leave it blank to display the service name (Discord/Slack). It does not change the Bot's name. Saving displays restart guidance. To apply the change now, ask xangi to restart.

In Web settings, edit a saved Agent and select **Discord・Slackの専用Bot → 接続を追加**, then choose Discord. Enter a dedicated Bot token and allowed user IDs. Create, invite and authorize the Bot as described above. Tokens already used by the shared Bot or another connection are rejected.

Additions, edits, disabling and deletion apply after restarting the main xangi process. Each Bot is pinned to its registered Agent; channel Agent switching cannot change it. Instructions, AI settings and workspaces are copied at startup. Existing conversations retain their snapshots, so start a new conversation after restarting to pick up Agent changes.

In the assigned work channel and its threads, use the dedicated Discord Bot’s `/backend set` to update the Agent’s backend, model, and effort. Use `/backend reset` to restore inheritance from the instance defaults. The main instance saves both changes, and they take effect from the next normal turn. Use `/backend status` to check which settings the next turn will use.

`/workspace use|set|reset` and changes to Local LLM mode and reasoning effort through `/settings item:llmmode|llmeffort` are also saved by the main instance and take effect from the Agent’s next normal turn. The defaults addressed by `/backend scope:global` and the `/settings item:respondtobots` preference are saved per dedicated Bot.

Each connection runs an isolated child runtime with separate history, schedules and tool credentials. State is retained under `DATA_DIR/agent-connections/<connection-ID>/`; session activity is shared with the main Monitor and pets. Open history from the shared Web UI conversation list and send through the dedicated Bot that owns the conversation. Deleting a connection does not erase history. Reload settings to refresh connection status. Credentials are stored in `DATA_DIR/agent-connections.json` with mode 600 and never returned by the API. Keep the data directory out of Git.


### Scheduled delivery for assigned Agents

When a channel's assigned Agent has one enabled dedicated Bot for that service, existing schedules owned by the main runtime execute and post through that dedicated Bot. Recreating or moving schedules is unnecessary; their timing and instructions remain unchanged. The Agent is resolved from channel settings on every run, so changing the assignment also changes the Agent for existing schedules on their next run. No Agent names or schedule IDs are special-cased.

Delivery fails if the selected dedicated Bot is disconnected or disabled, or multiple dedicated Bots are enabled for the same Agent/service. The shared Bot does not take over. Keep one dedicated Bot enabled per Agent/service for scheduled delivery, and grant it access and posting permissions in the destination channel.

In a source checkout, non-secret advanced settings such as allowed user IDs can still be placed in `.env`:

```bash
# Allowed user ID (single user only)
DISCORD_ALLOWED_USER=YOUR_DISCORD_USER_ID
```

## 7. Verify It Works

```bash
# Build
npm run build

# Start with Docker
docker compose up xangi -d --build

# Check logs
docker compose logs -f xangi
```

Try `/new` or `/skill` in your Discord server, or mention the bot:

```
@xangi Hello!
```

## How to Find IDs

### Enable Developer Mode

1. Discord Settings → Advanced → Turn **Developer Mode** ON

### User ID

1. Right-click a user → **"Copy User ID"**

### Channel ID

1. Right-click a channel → **"Copy Channel ID"**

## Troubleshooting

### Bot Doesn't Respond

1. Verify that **Message Content Intent** is ON
2. Verify the bot has been invited to the server
3. Verify `DISCORD_ALLOWED_USER` is set correctly

### Slash Commands Don't Appear

1. Verify the bot was invited with the `applications.commands` scope
2. Remove the bot from the server and re-invite
3. Restart Discord

### "Discord token not configured" Error

Open `xangi settings` and confirm that Discord is marked as configured.

### The thread `Close` button does not remove the user

Enable Manage Threads for the bot role or the target channel. Without it, the Discord API returns `Missing Access` or `Missing Permissions`.

## Security Notes

- **Never paste tokens into Git or an AI conversation**
- **Never expose tokens publicly** (regenerate immediately if leaked)
- `DISCORD_ALLOWED_USER` restricts usage to a single user (in compliance with Claude Code Terms of Service)
