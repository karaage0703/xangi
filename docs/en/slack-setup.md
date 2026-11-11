[日本語](../slack-setup.md) | English

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

### Optional: Create from a Manifest

If you select **"From an app manifest"** when creating the Slack App, you can configure Socket Mode / Event Subscriptions / OAuth scopes in one step. Paste the following manifest if you want to reduce manual setup.

```yaml
display_information:
  name: xangi
  description: AI CLI assistant for Slack
  background_color: '#2f3136'
features:
  bot_user:
    display_name: xangi
    always_online: false
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - channels:read
      - chat:write
      - files:read
      - files:write
      - groups:history
      - groups:read
      - im:history
      - im:read
      - im:write
      - reactions:read
      - reactions:write
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - message.im
      - reaction_added
  interactivity:
    is_enabled: true
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
```

Even when using the manifest, you still need to create an App-Level Token (`connections:write`), install the app to the workspace, and copy the Bot User OAuth Token / App Token. Slash commands are not included in the manifest to avoid environment-specific Request URL behavior; add them manually in Step 6 only if needed.

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

| Event              | Description                       | Purpose                         |
| ------------------ | --------------------------------- | ------------------------------- |
| `app_mention`      | When the bot is mentioned         | Required                        |
| `reaction_added`   | When a deletion reaction is added | For reaction-based deletion     |
| `message.im`       | When a DM is received             | For DM support                  |
| `message.channels` | Messages in public channels       | For responding without mentions |
| `message.groups`   | Messages in private channels      | For responding without mentions |

> **Warning**: `message.channels` / `message.groups` are required if you use `SLACK_AUTO_REPLY_CHANNELS`

## 5. OAuth & Permissions Settings

1. Click **"OAuth & Permissions"** in the left menu
2. Under **"Scopes"** → **"Bot Token Scopes"**, add the following:

| Scope               | Description                      | Purpose                         |
| ------------------- | -------------------------------- | ------------------------------- |
| `app_mentions:read` | Read mentions                    | Required                        |
| `chat:write`        | Send messages                    | Required                        |
| `files:read`        | Read files                       | For file attachment support     |
| `files:write`       | Upload files                     | For sending generated files     |
| `reactions:read`    | Read reaction events             | For reaction-based deletion     |
| `reactions:write`   | Add reactions (e.g. eyes emoji)  | Required                        |
| `im:history`        | Read DM history                  | For DM support                  |
| `im:read`           | Read DMs                         | For DM support                  |
| `im:write`          | Send DMs                         | For DM support                  |
| `channels:read`     | Read public channel information  | For `xangi tool slack_channels`  |
| `groups:read`       | Read private channel information | For `xangi tool slack_channels`  |
| `channels:history`  | Read public channel history      | For responding without mentions |
| `groups:history`    | Read private channel history     | For responding without mentions |

### User Token Scopes (Optional)

To act as the token owner, add the scopes for the intended operation under **OAuth & Permissions → User Token Scopes**. These are configured separately from Bot Token Scopes.

| Purpose | User Token Scope | Official Slack API reference |
| --- | --- | --- |
| Post messages as yourself | `chat:write` | [chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/) |
| Only when creating a public channel as yourself through the API | `channels:write` | [conversations.create](https://docs.slack.dev/reference/methods/conversations.create/) |
| Read Slack Lists through the API | `lists:read` | [slackLists.items.list](https://docs.slack.dev/reference/methods/slackLists.items.list/) |
| Create or update Slack Lists through the API | `lists:write` | [slackLists.create](https://docs.slack.dev/reference/methods/slackLists.create/) / [slackLists.update](https://docs.slack.dev/reference/methods/slackLists.update/) |

For posting as yourself, add `chat:write`. `channels:write` is not required for posting. The channel creation and Slack Lists rows apply when using those APIs separately. Add only the scopes needed for the intended operations, then have the token owner reauthorize the app and obtain a new User OAuth Token after scope changes. See [Step 8](#post-as-yourself-optional) for the posting setup.

After adding or changing scopes/events, reinstall the app from **"Install App"** in the left menu. Without reinstalling, `reaction_added` and `reactions:read` will not take effect.

## 6. Register Slash Commands (Optional)

To use native commands, register these names under **Slash Commands → Create New Command** in Slack App management. xangi derives its handlers, help, and feature gates from the same catalog as Discord. Updating Socket Mode handlers does not create or delete Slack App registrations.

| Command | Usage Hint | Purpose |
| --- | --- | --- |
| `/secret` | `on\|off\|status` | Secret conversation |
| `/new` | | New conversation |
| `/stop` | | Stop execution |
| `/skill` | `[name] [args]` | List/run skills in the current Workspace |
| `/settings` | `[item] [value]` | Shared settings |
| `/agent` | `list\|status\|set <id>\|reset` | Inspect/change the conversation Agent |
| `/workspace` | `status\|list\|use <name>\|set <name> <path>\|reset` | Inspect/change the workspace |
| `/backend` | `status\|models [type]\|set <type> [--model model] [--effort effort] [--scope channel\|global]\|reset` | Backend, models, effort |
| `/schedule` | `add <input>\|list\|remove <id>\|toggle <id>` | Slack schedules |
| `/help` | | Enabled commands |
| `/autoreply` | `status\|on\|off\|default` | Mention-free replies |
| `/threadmode` | `status\|on\|off\|default` | Reply in threads |

`ALLOW_AUTOREPLY_COMMAND` and `ALLOW_THREAD_MODE_COMMAND` apply to both Discord and Slack native registrations. Disabled operations are also omitted from `/help`.

When migrating an existing App, delete its `/models`, `/restart`, and `/delete` registrations and add missing entries above. Use `/backend models`, the administrative CLI, and the existing deletion reactions respectively. Do not register `/team` or `/extend`.

A direct `/<skill-name>` also needs a matching App registration. Use `/skill name args` for unregistered, reserved, or ambiguous names. Execution validates skills against the current conversation's Workspace; direct aliases come from registered Workspaces at startup.

The exception is `/retitle`: Slack threads consist of a parent message and replies, so independent thread-title regeneration is unsupported. [Slack's native command specification](https://docs.slack.dev/interactivity/implementing-slash-commands/) also disallows app commands inside threads and supplies no thread ID. `/new`, Agent, and Workspace settings therefore address the channel and retain existing thread histories/workspaces. If multiple tasks are active, use the stop button in the target thread.

Without new registrations, continue using ordinary mentions and natural-language requests. Mention-prefixed `/backend ...` is still ordinary AI input rather than a dedicated command route.

## 7. Install to Workspace

1. Click **"Install App"** in the left menu
2. Click **"Install to Workspace"**
3. Review permissions and click **"Allow"**
4. **Copy the displayed Bot User OAuth Token (xoxb-...)**

## 8. Set the tokens

```bash
xangi settings
```

Enter the Bot Token (xoxb-...), App Token (xapp-...), and allowed user IDs in the Slack fields on the local settings page, then save them. Separate multiple users with commas, or use `*` to allow everyone.

In a source checkout, the same allowed user IDs and other advanced settings can be placed in `.env`:

```bash
# Allowed user ID (Slack User ID)
SLACK_ALLOWED_USER=U01234567

# Optional: Post replies directly in specific channels instead of threads
SLACK_REPLY_IN_CHANNELS=C01234567

# Optional: Delete bot messages with `:wastebasket:` / `:x:` reactions (enabled by default)
SLACK_REACTION_DELETE_ENABLED=true
SLACK_DELETE_REACTIONS=wastebasket,x
```

> When using only Slack, leave the Discord field unconfigured in `xangi settings`.

### Post as yourself (optional)

Normal replies and CLI operations use the bot identity. For an action requested by the token owner, select the saved user identity with `slack_send --as user`. Adding bot scopes alone does not select the owner's identity. This uses the User Token Scope `chat:write`, following Slack's [user token documentation](https://docs.slack.dev/authentication/tokens/#user-tokens) and [chat.postMessage reference](https://docs.slack.dev/reference/methods/chat.postMessage/).

1. Add `chat:write` under **OAuth & Permissions → User Token Scopes** in your Slack App.
2. The person who will post must reauthorize the app in the target workspace and obtain a **User OAuth Token**, distinct from the Bot User OAuth Token.
3. Save it in the **本人名義投稿用User OAuthトークン** field of `xangi settings`. The existing private secret store uses file permissions 0600 and never displays saved values. Source installations can also set `SLACK_USER_TOKEN`; environment values take precedence. Do not paste tokens into chat or command-line arguments.
4. After the next xangi startup, verify the owner-approved content and destination before executing.

```bash
xangi tool slack_send --as user --channel C01234567 --message "Here is an update"
xangi tool slack_send --as user --channel C01234567 --thread-ts 1719876543.000100 --message "Thread follow-up"
```

Use `slack_edit --as user` / `slack_delete --as user` to edit or delete messages posted by that user. Omitting `--as`, or specifying `--as bot`, keeps the bot token. Missing, expired, revoked, or insufficiently scoped user tokens cause an error; xangi never retries the operation as the bot. History and channel lists still use bot permissions and reject `--as`.

There is one configured user per instance. Anyone or any agent able to call its tool-server can act as that user, so use a dedicated instance owned by that person. Select `--as user` only for actions explicitly requested by the owner. The token does not need to enter the AI CLI environment. Normal bot replies and events still require the bot/app tokens.

OAuth callbacks, multi-user linking, and automatic token refresh are outside this feature. Apps with token rotation must refresh and save their access token before expiry; it is loaded on the next xangi startup. The user must also have channel membership and permission to post.

## 9. Verify It Works

```bash
# Build
npm run build

# Start with Docker
docker compose up xangi -d --build

# Check logs
docker compose logs -f xangi
```

Try the following in Slack:

- Mention the bot: `@xangi Hello!`
- Send a DM
- `/new` command
- `/skill` command
- Add a `:wastebasket:` or `:x:` reaction to a bot message to delete it

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

Open `xangi settings` and confirm that both Slack fields are marked as configured.

### Bot Doesn't Respond in DMs

1. Verify `im:history` and `im:read` are in OAuth Scopes
2. Verify `message.im` is set in Event Subscriptions

## Inviting the Bot to a Channel

To use the bot in a channel, you need to invite it:

```
/invite @xangi
```

## Security Notes

- **Never paste tokens into Git or an AI conversation**
- **Never expose tokens publicly** (regenerate in Slack App settings if leaked)
- `SLACK_ALLOWED_USER` restricts usage to a single user (in compliance with Claude Code Terms of Service)

## References

- [Slack API Documentation](https://api.slack.com/docs)
- [Bolt for JavaScript](https://slack.dev/bolt-js/)
- [Socket Mode](https://api.slack.com/apis/connections/socket)
