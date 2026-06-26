[日本語](../discord-setup.md) | **English**

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

| Intent | Required | Description |
|--------|----------|-------------|
| Presence Intent | Optional | Retrieve user online status |
| Server Members Intent | Optional | Retrieve server member info |
| **Message Content Intent** | **Required** | Read message content |

**Warning: The bot cannot read messages unless Message Content Intent is turned ON!**

## 5. Invite the Bot to Your Server

1. Go to **"OAuth2"** → **"URL Generator"** in the left menu
2. Under **SCOPES**, select:
   - `bot`
   - `applications.commands` (for slash commands)
3. Under **BOT PERMISSIONS**, select:
   - Send Messages
   - Send Messages in Threads
   - Read Message History
   - Add Reactions
   - Use Slash Commands
4. Copy the generated URL
5. Open the URL in your browser and select the server to invite the bot to

## 6. Set Environment Variables

```bash
# Edit .env
cp .env.example .env
vim .env
```

```bash
# Discord Bot Token
DISCORD_TOKEN=YOUR_BOT_TOKEN_HERE

# Allowed user ID (single user only)
DISCORD_ALLOWED_USER=YOUR_DISCORD_USER_ID
```

## 7. Verify It Works

```bash
# Build
npm run build

# Start with Docker
docker compose up -d --build

# Check logs
docker logs -f xangi
```

Try `/new` or `/skills` in your Discord server, or mention the bot:
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

The `DISCORD_TOKEN` in `.env` is empty. Set the token.

## Security Notes

- **Never commit tokens to Git** (`.env` is already in `.gitignore`)
- **Never expose tokens publicly** (regenerate immediately if leaked)
- `DISCORD_ALLOWED_USER` restricts usage to a single user (in compliance with Claude Code Terms of Service)
