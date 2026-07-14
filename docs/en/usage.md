[日本語](../usage.md) | **English**

# Usage Guide

Detailed usage guide for xangi.

## Table of Contents

- [Basic Usage](#basic-usage)
- [Channel Topic Injection](#channel-topic-injection)
- [Timestamp Injection](#timestamp-injection)
- [Session Management](#session-management)
- [Scheduler](#scheduler)
- [Terminal CLI (xangi)](#terminal-cli-xangi)
- [Chat Operations (xangi-cmd)](#chat-operations-xangi-cmd)
- [Event Trigger](#event-trigger)
- [Runtime Settings](#runtime-settings)
- [Autonomous AI Operations](#autonomous-ai-operations)
- [Docker Deployment](#docker-deployment)
- [Local LLM](#local-llm)
- [Workspace Hooks (Stop Hook)](#workspace-hooks-stop-hook)
- [Tool Trajectory Logger](#tool-trajectory-logger)
- [Security](#security)
- [Environment Variables Reference](#environment-variables-reference)
- [Running Multiple Instances](#running-multiple-instances)
- [Session Retention](#session-retention)
- [Options](#options)
- [Troubleshooting](#troubleshooting)

## Basic Usage

### Mention to Invoke

```
@xangi your question here
```

### Dedicated Channels

Channels enabled with `/autoreply` will respond without requiring a mention. The setting is persisted in `settings.json`.

## Channel Topic Injection

When a Discord channel has a topic (description) set, its content is automatically injected into the prompt.

This allows you to provide different context or instructions to the AI for each channel.
Messages inside Discord threads inherit the parent channel topic. The conversation session and run lock still use the thread ID, but prompt instructions come from the parent channel.

### How to Configure

Go to Discord channel settings and write natural language instructions in the "Topic" field.

### Examples

- `Always read ~/project/README.md before starting work`
- `Respond in English in this channel`
- `Always search memory-RAG before responding`

If the topic is empty, nothing is injected.

## Timestamp Injection

The current time (JST) is automatically injected at the beginning of the prompt. This helps the AI recognize the passage of time and make time-related decisions more accurately.

Enabled by default. To disable:

```bash
INJECT_TIMESTAMP=false
```

Injection format: `[Current time: 2026/3/8 12:34:56]`

## Session Management

| Command               | Description         |
| --------------------- | ------------------- |
| `/new`, `!new`, `new` | Start a new session |

### Discord Button Controls

Buttons are displayed on response messages.

- **During processing**: `Stop` / `延長` (Extend) / `⏱ MM:SS` buttons
  - `Stop` — equivalent to `/stop`. Interrupts the task
  - `延長` (Extend) — **doubles the remaining time** (adds residual to the deadline, capped at `TIMEOUT_MAX_MS`)
  - `⏱ MM:SS` — remaining time badge (click does nothing, turns red under 30s)
- **After completion**: `New` button — equivalent to `/new`. Resets the session
- **After completion in a Discord thread**: `Leave` button — removes the user who clicked it from the thread, removing the thread from that user's sidebar. The bot requires the Discord Manage Threads permission

Set `DISCORD_SHOW_BUTTONS=false` to hide buttons.

Reply suggestions are disabled by default. When enabled, Discord and Slack completed messages show only one `返信候補` button. Opening it reveals suggestions and number buttons only to that user; selecting one continues the same session. Web Chat provides the same collapsed control below each response. Discord's `/replysuggestions mode:on|off|show|default` switches the feature globally. OFF skips prompt injection, so no extra suggestion tokens or generation latency are incurred. Set the platform-specific `*_REPLY_SUGGESTIONS=true` variables to enable the feature at startup, and use `*_REPLY_SUGGESTIONS_COUNT` to change the default count of 3.

### Dynamic Timeout Extension

Long-running tasks (code generation, deep research, etc.) can be extended via
the `延長` button before the initial timeout (`TIMEOUT_MS`, default 30 minutes)
fires. The button **doubles the remaining time** at the moment of the click.

- Initial timeout: `TIMEOUT_MS` (default 30 minutes)
- Extension behavior: adds the current remaining time to the deadline → remaining time becomes **2x**
  - e.g. 3 min remaining → click → 6 min remaining
  - e.g. 30 sec remaining → click → 1 min remaining (last-resort recovery)
- Absolute cap: `TIMEOUT_MAX_MS` (default 36000000ms = 10 hours)
  - Adjust it via `TIMEOUT_MAX_MS` to allow longer runs or enforce a tighter cap (e.g. `TIMEOUT_MAX_MS=3600000` = 1h)
- On/off: `TIMEOUT_EXTEND_ENABLED` (default `true`)
  - When `false`, the `延長` button is hidden and `extendTimeout` API returns `unsupported`
- UI:
  - Web Chat — `[延長][⏱ MM:SS]` shown next to the `⏹` button in the composer (only while sending)
  - Discord — `[Stop][延長][⏱ MM:SS]` row on the "Thinking…" message, including turns started by schedules / triggers
  - Slack — same buttons in the Block Kit actions block, including turns started by schedules / triggers
- Display turns red + pulses when under 30 seconds remain
- `延長` is disabled / hidden once the cap is reached

Supported backends: Claude Code (persistent-runner), Codex CLI, Cursor CLI,
Grok CLI, Antigravity CLI, Local LLM, Dynamic Runner (forwards to inner runner).

Programmatic API:

- `GET /api/sessions/:id/timeout` — current state `{active, timeoutAt, maxTimeoutAt, remainingMs, timeoutMs}`
- `POST /api/sessions/:id/timeout/extend` — `{additionalMs?: number}`, defaults to 5 minutes

> 💡 An optional approval flow can prompt for confirmation before dangerous commands run (disabled by default). See [Options > Dangerous Command Approval](#dangerous-command-approval).

## Scheduler

Set up periodic tasks and reminders. Ask the AI in natural language, and it calls `xangi-cmd schedule_add` etc. on your behalf.

### How to Operate

| Entry point                 | Description                                                   |
| --------------------------- | ------------------------------------------------------------- |
| `/schedule` (Discord slash) | Add / list / remove / toggle schedules via GUI                |
| `xangi-cmd schedule_*`      | Operate from AI or CLI (see below)                            |
| Natural language            | Say e.g. "remind me at 9am every day" and the AI registers it |

### Time Specification Formats

#### One-time Reminders

```
30 minutes later, remind me about XX
1 hour later, prepare for the meeting
15:30 notify at 3:30 PM today
```

#### Recurring (Natural Language)

```
Every day 9:00 morning greeting
Every day 18:00 write daily report
Every Monday 10:00 weekly report
Every Friday 17:00 check weekend plans
```

#### Cron Expressions

For more fine-grained control, cron expressions are also supported:

```
0 9 * * * Every day at 9:00
0 */2 * * * Every 2 hours
30 8 * * 1-5 Weekdays at 8:30
0 0 1 * * 1st of every month
```

| Field       | Value | Description             |
| ----------- | ----- | ----------------------- |
| Minute      | 0-59  |                         |
| Hour        | 0-23  |                         |
| Day         | 1-31  |                         |
| Month       | 1-12  |                         |
| Day of Week | 0-6   | 0=Sunday, 1=Monday, ... |

### `xangi-cmd schedule_*`

Operate schedules directly from the AI or shell. When invoked by the AI inside xangi, `--channel` can be omitted (the current channel ID is used).

```bash
# Add a schedule (natural language)
xangi-cmd schedule_add --input "Every day 9:00 good morning"
xangi-cmd schedule_add --input "30 minutes later, meeting"
xangi-cmd schedule_add --input "15:00 review"
xangi-cmd schedule_add --input "Every Monday 10:00 weekly MTG"
xangi-cmd schedule_add --input "cron 0 9 * * * good morning"

# Send to another channel
xangi-cmd schedule_add --input "Every day 9:00 good morning" --channel <channelId>

# List schedules
xangi-cmd schedule_list

# Remove by ID
xangi-cmd schedule_remove --id <scheduleId>

# Enable/disable toggle
xangi-cmd schedule_toggle --id <scheduleId>
```

### Data Storage

Schedule data is saved in `${DATA_DIR}/schedules.json`.

- Default: `/workspace/.xangi/schedules.json`
- Configurable via the `DATA_DIR` environment variable

## Terminal CLI (xangi)

`xangi` is a thin terminal client for humans to connect to xangi Web sessions. It consumes the existing Even Terminal compatible API (`/api/sessions`, `/api/prompt`, `/api/messages`, `/api/status`) and does not spawn Claude Code, Codex CLI, or other backends directly. The actual backend / model is resolved by the xangi server or the `XANGI_EVEN_TERMINAL_BACKEND` settings.

`xangi` is the human/operator CLI for sessions and service operations. `xangi-cmd` remains the internal platform/tool CLI used by agents and integration scripts.

```bash
# Put the development xangi command on PATH
cd ~/xangi-dev
npm link

# Without npm link, for a single clone
mkdir -p ~/.local/bin
ln -sf ~/xangi-dev/bin/xangi ~/.local/bin/xangi

# For multiple clones, prefer named symlinks
ln -sf ~/xangi-dev/bin/xangi ~/.local/bin/xangi-dev
ln -sf ~/xangi-prod/bin/xangi ~/.local/bin/xangi-prod

# List sessions
xangi sessions --url http://127.0.0.1:18888

# Send to a new session and wait for the response
xangi send "Check this repository state"

# Send from stdin
git diff | xangi send -

# Send to an existing session and wait for the response
xangi send --session <sessionId> "Please continue"

# Send only and return the session ID
xangi send --detach "Queue this task for later"

# Interactive REPL
xangi chat --session <sessionId>
```

Main options:

| Option           | Description                                                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `--url`          | xangi Web Chat URL. Resolution order: `XANGI_URL`, `XANGI_CLI_URL`, `~/.config/xangi/config.json`, then `http://127.0.0.1:18888` |
| `--token`        | Even Terminal compatible API token. Falls back to `.env`, `XANGI_TOKEN`, `XANGI_EVEN_TERMINAL_TOKEN`, then config                |
| `--provider`     | Even Terminal compatibility label (`claude` / `codex`), not a direct backend selector                                            |
| `--session`      | Web session ID to attach to                                                                                                      |
| `--detach`, `-d` | Return after sending the prompt and printing the session ID                                                                      |

`send` polls `/api/messages` and prints the final response by default. Use `--detach` only when the command should return immediately.

On startup, the CLI also reads `XANGI_ENV_PATH`, `XANGI_DIR/.env`, and the current directory's `.env`. When running from `~/xangi-dev`, you normally do not need to pass `--token` manually.

If `~/.local/bin` is not on PATH, add `export PATH="$HOME/.local/bin:$PATH"` to your shell config.

Example config:

```json
{
  "url": "http://127.0.0.1:18888",
  "token": "your-token",
  "provider": "codex",
  "sessionId": "optional-default-session"
}
```

## Chat Operations (xangi-cmd)

The AI performs Discord / Slack operations via the `xangi-cmd` CLI tool. Because it routes through xangi's built-in tool-server (HTTP API), secrets like `DISCORD_TOKEN` / `SLACK_BOT_TOKEN` are never accessible to the AI CLI.

| Command                                                                         | Description                                                                                                                 |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `xangi-cmd discord_history --channel <ID> [--count N] [--offset M]`             | Get channel history                                                                                                         |
| `xangi-cmd web_history [--session <id>] [--count N]`                            | Web Chat current pane history (auto-resolves from `XANGI_CHANNEL_ID=web-chat:<id>`)                                         |
| `xangi-cmd slack_history [--channel <id>] [--count N]`                          | Slack current channel history (auto-resolves from `XANGI_CHANNEL_ID=<channel>`)                                             |
| `xangi-cmd discord_send --channel <ID> --message "text"`                        | Send a message                                                                                                              |
| `xangi-cmd discord_channels --guild <ID>`                                       | List channels                                                                                                               |
| `xangi-cmd discord_search --channel <ID> --keyword "text"`                      | Search messages                                                                                                             |
| `xangi-cmd discord_edit --channel <ID> --message-id <ID> --content "text"`      | Edit a message                                                                                                              |
| `xangi-cmd discord_delete --channel <ID> --message-id <ID>`                     | Delete a message                                                                                                            |
| `xangi-cmd discord_thread_leave --user <ID> [--channel <ID>]`                   | Remove a user from a thread = drop it from that user's sidebar (defaults to the current thread when `--channel` is omitted) |
| `xangi-cmd media_send --channel <ID> --file /path/to/file`                      | Send a file                                                                                                                 |
| `xangi-cmd slack_send --channel <id> --message "text" [--thread-ts <ts>]`       | Send a Slack message                                                                                                        |
| `xangi-cmd slack_channels [--types public_channel,private_channel] [--limit N]` | List Slack channels                                                                                                         |
| `xangi-cmd slack_search --channel <id> --keyword "text" [--count N]`            | Search Slack messages                                                                                                       |
| `xangi-cmd slack_edit --channel <id> --message-ts <ts> --content "text"`        | Edit a Slack message                                                                                                        |
| `xangi-cmd slack_delete --channel <id> --message-ts <ts>`                       | Delete a Slack message                                                                                                      |

On Slack, when `SLACK_REACTION_DELETE_ENABLED=true` (default) and the Slack App subscribes to the `reaction_added` event with the `reactions:read` scope, an allowed user can delete a bot message by adding a `:wastebasket:` or `:x:` reaction. Customize the reaction names with `SLACK_DELETE_REACTIONS=wastebasket,x`.

### Examples

```bash
# Get channel history
xangi-cmd discord_history --count 10
xangi-cmd discord_history --channel 1234567890 --count 10
xangi-cmd discord_history --channel 1234567890 --count 30 --offset 30  # scroll back

# Send a message to another channel
xangi-cmd discord_send --channel 1234567890 --message "Work completed!"

# List channels
xangi-cmd discord_channels --guild 9876543210

# Search messages
xangi-cmd discord_search --channel 1234567890 --keyword "PR"

# Slack operations
xangi-cmd slack_send --channel C01234567 --message "Work completed!"
xangi-cmd slack_send --channel C01234567 --thread-ts 1719876543.000100 --message "Thread reply"
xangi-cmd slack_channels --types public_channel,private_channel --limit 100
xangi-cmd slack_search --channel C01234567 --keyword "PR" --count 15
```

If `--channel` is omitted while running inside xangi, the current channel ID is used automatically. When running the CLI standalone, `--channel` is required.

```bash
# Edit and delete messages
xangi-cmd discord_edit --channel 1234567890 --message-id 111222333 --content "updated content"
xangi-cmd discord_delete --channel 1234567890 --message-id 111222333

# Remove a user from a thread = drop it from that user's sidebar (omit --channel to target the current thread)
xangi-cmd discord_thread_leave --user 111222333
xangi-cmd discord_thread_leave --user 111222333 --channel 1234567890
xangi-cmd slack_edit --channel C01234567 --message-ts 1719876543.000100 --content "updated content"
xangi-cmd slack_delete --channel C01234567 --message-ts 1719876543.000100
```

### Tool Server

`xangi-cmd` relays requests to the tool-server (HTTP API) running inside the xangi process.

- Port is assigned automatically by the OS (no conflicts when running multiple instances)
- xangi injects `XANGI_TOOL_SERVER` into child processes at startup
- `xangi-cmd` uses `XANGI_TOOL_SERVER` to resolve the connection endpoint
- Runtime context such as the current channel ID is passed to the tool-server as `context`

## Event Trigger

You can start an agent turn from an external event (build finished, CI result, new content detected, etc.). This replaces polling (periodic schedule checks) with push (wake only when something happened), improving responsiveness and eliminating wasted turns.

### Enabling

Add the following to `.env` (disabled by default):

```bash
TRIGGER_ENABLED=true
XANGI_TRIGGER_TOKEN=<long random string>   # e.g. openssl rand -hex 32
# TRIGGER_MIN_INTERVAL_MS=10000            # minimum interval per source (default: 10s)
```

The token is mandatory. If `XANGI_TRIGGER_TOKEN` is not set, all HTTP requests are rejected even with `TRIGGER_ENABLED=true` (the tool-server is exposed on the network, so accepting unauthenticated requests would allow arbitrary prompt injection).

### Firing via HTTP

```bash
curl -X POST "$XANGI_TOOL_SERVER/api/trigger" \
  -H "Authorization: Bearer $XANGI_TRIGGER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "channel": "<channel ID>",
    "message": "docker build finished. Check the result and report.",
    "source": "docker-build"
  }'
```

- `channel` (required): channel ID where the turn runs and results are posted
- `message` (required): instruction for the agent (max 4000 chars)
- `source` (optional): identifier of the event origin (alphanumerics plus `_.:-`, max 64 chars). Used as the display label and the rate-limit key
- `platform` (optional): `discord` (default) or `slack`

On success it returns `202 { "ok": true, "triggerId": "trg_..." }` immediately (it does not wait for the turn to finish). A `⚡ trigger: <source>` label is posted to the channel, followed by the agent's response.

### Firing via xangi-cmd

Local scripts can also fire a trigger via `xangi-cmd` (no token needed; `TRIGGER_ENABLED=true` is still required):

```bash
xangi-cmd trigger --channel <channel ID> --message "Build finished. Report the result." --source build
```

When `TRIGGER_ENABLED=true`, this usage is also injected into the agent's own system prompt (XANGI_COMMANDS). The common prompt requires long-running work to survive the end of the current tool execution or turn, verifies that it started and remains alive, and persists its log and exit status. Each workspace defines the concrete launch and verification method because it depends on the operating system and execution backend. The completion or failure handler can fire a trigger to start a new turn.

### Abuse protection

- Repeated fires from the same `source` within `TRIGGER_MIN_INTERVAL_MS` (default 10s) are rejected (`429`)
- While a turn for the same `source` is running, new fires are rejected (`409`)

## Runtime Settings

Runtime settings are saved in `${DATA_DIR}/settings.json` (default: `${WORKSPACE_PATH}/.xangi/settings.json`).

```json
{
  "discordAutoReplyChannels": {
    "123456789012345678": true
  },
  "discordCompletionNotifyChannels": {
    "123456789012345678": "mention"
  },
  "discordThreadModeChannels": {
    "123456789012345678": true
  }
}
```

| Setting                           | Description                                                                   | Default |
| --------------------------------- | ----------------------------------------------------------------------------- | ------- |
| `discordAutoReplyChannels`        | Per-channel mention-free auto-reply settings (`true` / `false`)               | none    |
| `discordCompletionNotifyChannels` | Per-channel completion notification overrides (`off` / `message` / `mention`) | none    |
| `discordThreadModeChannels`       | Per-channel Discord thread reply overrides (`true` / `false`)                 | none    |

### Viewing and Changing Settings

| Command                                          | Description                                                                                                           |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `/settings`                                      | Show current settings                                                                                                 |
| `/restart`                                       | Restart the bot only when `.env` has `XANGI_SELF_LIFECYCLE=restart-only`                                           |
| `/autoreply <on\|off\|default\|show>`            | Configure mention-free auto-reply for this channel (no restart needed, persisted to `settings.json`)                  |
| `/notify <off\|message\|mention\|default\|show>` | Configure completion notifications for this channel (no restart needed, persisted to `settings.json`)                 |
| `/respondtobots`                                 | Toggle bot-to-bot reply ON/OFF (whitelist set via `RESPOND_TO_BOTS` env)                                              |
| `/threadmode <on\|off\|default\|show>`           | Show or toggle this channel's Discord per-message thread reply mode (no restart needed, persisted to `settings.json`) |
| `/llmmode <agent\|lite\|chat\|default\|show>`    | Switch this channel's Local LLM operation mode (persisted to `CHANNEL_OVERRIDES` in `.env`)                           |

### Backend Dynamic Switching

You can switch the backend, model, and effort level per channel.

| Command                                          | Description                               |
| ------------------------------------------------ | ----------------------------------------- |
| `/backend show`                                  | Show the current backend and model        |
| `/backend set claude-code`                       | Switch to Claude Code                     |
| `/backend set cursor`                            | Switch to Cursor CLI                      |
| `/backend set grok`                              | Switch to Grok CLI                        |
| `/backend set local-llm --model nemotron-3-nano` | Switch to Local LLM with a specific model |
| `/backend set claude-code --effort high`         | Switch with a specific effort level       |
| `/backend reset`                                 | Reset to the default (.env settings)      |
| `/backend list`                                  | List available backends and models        |

Switching always starts a new session (conversation history is not carried over).

#### Restricting via Environment Variables

```bash
# Allowed backends for switching (if unset, all backends are allowed)
ALLOWED_BACKENDS=claude-code,cursor,grok,antigravity,local-llm

# Allowed models for switching (if unset, no restriction)
ALLOWED_MODELS=nemotron-3-nano,nemotron-3-super,qwen3.5:9b

# Per-channel backend overrides (JSON)
CHANNEL_OVERRIDES={"channelId":{"backend":"local-llm","model":"nemotron-3-nano"}}
```

#### Persistence

Settings changed with `/backend set` are automatically saved to `CHANNEL_OVERRIDES` in `.env` and persist across restarts.
Inside Discord threads, `/backend` and `/llmmode` read and write the parent channel's `CHANNEL_OVERRIDES`. Conversation sessions and run locks remain isolated by thread ID; only backend/model settings inherit from the parent channel.

In a Docker environment, `.env` lives outside the container and cannot be modified by the AI (Claude Code, etc.).

#### effort Option (Claude Code Only)

The Claude Code `--effort` option (`low` / `medium` / `high` / `max`) can be configured per channel. Because a process restart is required in persistent mode, the session resets on each switch. Use `/backend set claude-code --effort default` to clear the effort setting.

## Autonomous AI Operations

### Configuration Changes (Local Execution Only)

The AI can edit the `.env` file to change settings:

```
"Please respond in this channel too"
→ AI saves the equivalent `/autoreply` setting to `settings.json`
```

Use `/autoreply mode:on|off|default|show` to inspect or configure mention-free auto-reply for this channel while the bot is running (no restart needed, persisted to `settings.json`). `default` removes the channel setting and falls back to OFF.
To disable this command, set `ALLOW_AUTOREPLY_COMMAND=false` in `.env` (default: enabled).

Use `/threadmode mode:on|off|default|show` to inspect or toggle this channel's Discord per-message thread reply mode while the bot is running (no restart needed, persisted to `settings.json`). `default` removes the channel override and falls back to the global `DISCORD_REPLY_IN_THREAD` default.
For messages received inside an existing Discord thread, xangi automatically injects the thread starter message as `🧵 スレッド元`. This keeps the original parent-channel starter message available even when thread-local history does not include it.
Inside Discord threads, `/autoreply`, `/notify`, `/threadmode`, and channel topic injection inherit the parent channel settings.
To disable this command, set `ALLOW_THREAD_MODE_COMMAND=false` in `.env` (default: enabled).

Use `/notify` to configure separate completion notifications for long Discord turns per channel. `DISCORD_COMPLETION_NOTIFY` is the startup default, while channel overrides are stored in `settings.json`. This applies only to normal Discord message turns; scheduler-triggered turns do not send completion notifications.

### Responding to Other Bots (A/B Comparison)

By default, messages from other bots are ignored. Set the whitelist in `RESPOND_TO_BOTS` and toggle the feature with `RESPOND_TO_BOTS_ENABLED` or the `/respondtobots` command.

```
# Whitelist (preset)
RESPOND_TO_BOTS=*                       # all bots
RESPOND_TO_BOTS=1469919453155164160     # specific bot only

# Feature ON/OFF
RESPOND_TO_BOTS_ENABLED=true            # ON
RESPOND_TO_BOTS_ENABLED=false           # OFF (default)

# Consecutive-reply cap (default 3, 0 to disable)
RESPOND_TO_BOTS_MAX_CONSECUTIVE=3
```

The bot's own ID is always excluded (infinite-loop prevention). Messages from allowed bots bypass the `DISCORD_ALLOWED_USER` check.

Consecutive replies to the same bot are capped at `RESPOND_TO_BOTS_MAX_CONSECUTIVE` (default 3). The counter resets when a human or a different bot posts. This is a safety net against runaway bot-to-bot loops.

`/respondtobots` toggles the feature ON/OFF dynamically and persists to `.env`. To disable this command, set `ALLOW_RESPOND_TO_BOTS_COMMAND=false` in `.env` (default: enabled).

Use case: run multiple xangi instances (e.g. xangi-prod=Claude / xangi-dev=Local LLM) in the same channel and compare their responses to the same prompt side-by-side.

#### Constraints / Known Limitations

- Responding to bot messages still requires the normal gate: **mention / DM / channel enabled via `/autoreply`**. Whitelisting a bot via `RESPOND_TO_BOTS` does not make it reply across all channels. To test bot-to-bot replies, enable `/autoreply` in the test channel.
- `xangi-cmd discord_send` always sends with `allowed_mentions: { parse: [] }` to suppress notifications. As a result, mentions (`<@user_id>` / `<@&role_id>` / `@everyone`) embedded in messages sent via `xangi-cmd` are _not_ parsed into `message.mentions` on the receiving side (Discord-spec behaviour). Mention-based triggers from another bot using `xangi-cmd discord_send` will therefore not fire.
- Lifting that mention suppression would require an opt-in flag on `xangi-cmd discord_send` (out of scope of this feature).

### Message Split Separator

When the AI's response text contains `\n===\n` (i.e. `===` surrounded by newlines), the response is split and sent as separate messages. This works not only for scheduler-triggered responses but also for direct Discord mention messages. Useful when you want to generate multiple independent posts from a single LLM response.

```
Post explanation 1
> Post content...

===
Post explanation 2
> Post content...
```

The above response is sent as two separate messages to Discord.

### Restart Mechanism

`./bin/xangi service start|stop|restart|status` is the high-level command that controls the supervisor outside xangi. In PM2 deployments, it targets the process named by `XANGI_PROCESS_NAME` in that clone's `.env`.

`/restart` and `xangi-cmd system_restart` are low-level operations that ask the running xangi process to gracefully shut down. The external supervisor, such as Docker, pm2, or systemd, is responsible for starting xangi again.

To restart the xangi instance handling the current conversation, call `xangi-cmd system_restart` directly instead of delegating a delayed restart to a child process or scheduler. A successful response means that the restart request was accepted; confirm completion from the new process status, start time, and startup log. To operate a different clone, run that clone's `./bin/xangi service restart` directly and wait for completion.

Self restart permission is configured by the administrator in `.env` with `XANGI_SELF_LIFECYCLE`. It is not a runtime setting that the AI changes. Shutdown cannot be guaranteed from inside xangi itself, so stopping xangi is handled by the external lifecycle manager such as Docker, pm2, or systemd.

```mermaid
flowchart TD
  User[User or AI] --> Service[xangi service]
  Service --> Supervisor[Docker / pm2 / systemd]
  User --> Cmd[system_restart or /restart]
  Cmd --> Gate{XANGI_SELF_LIFECYCLE}
  Gate -->|off| Deny[Deny]
  Gate -->|restart-only| Graceful[Graceful shutdown]
  Graceful --> Supervisor
  Supervisor --> Start[Start xangi again]
```

- `off`: deny xangi-initiated restart
- `restart-only`: allow xangi-initiated restart only
- Self shutdown is handled by the external supervisor / lifecycle manager, not by xangi itself
- **Docker**: Automatically recovers with `restart: always`
- **Local**: Requires a process manager like pm2
- Changing `.env` requires restarting the xangi process

```bash
# Example with pm2
./bin/xangi service start
./bin/xangi service status
./bin/xangi service restart
./bin/xangi service stop
```

To start xangi automatically after an OS reboot, run the following once from the target clone:

```bash
./bin/xangi service start
./bin/xangi service autostart
```

`autostart` saves the current PM2 process list with `pm2 save`, then runs `pm2 startup` to show or register the OS startup integration. If `pm2 startup` prints a command such as `sudo env ... pm2 startup ...`, run that command once.

When running multiple clones, run `./bin/xangi service ...` from the target clone. If you want commands on PATH, prefer named symlinks such as `xangi-dev` / `xangi-prod` instead of one generic `xangi` symlink.

```bash
ln -sf /home/user/xangi-dev/bin/xangi ~/.local/bin/xangi-dev
ln -sf /home/user/xangi-prod/bin/xangi ~/.local/bin/xangi-prod

xangi-dev service status
xangi-prod service restart
```

`--dir <xangi-dir>` is an escape hatch for controlling another clone from a PATH-level `xangi`. For day-to-day operations, use the target clone's `./bin/xangi` or a named symlink.

`ecosystem.config.cjs` is a PM2 app definition file. It uses `.env`'s `XANGI_PROCESS_NAME` as the PM2 process name, falling back to `XANGI_INSTANCE_ID` and then the directory name. It also defines the script and `node --env-file=.env` arguments. `./bin/xangi service start` uses this config to ask PM2 to start xangi. The `.cjs` extension keeps the PM2 config in CommonJS (`module.exports`) even though this package uses ESM (`"type": "module"`).

### Changing Environment Variables with pm2

xangi loads environment variables via `node --env-file=.env`. To change environment variables, **edit the `.env` file and then run `./bin/xangi service restart`**.

```bash
# Correct method: edit .env then restart
vim .env  # Add TIMEOUT_MS=60000
./bin/xangi service restart
```

> **Warning: Do not use `pm2 restart --update-env`!**
> `--update-env` saves all shell environment variables to pm2. If you're running multiple xangi instances, another instance's `DISCORD_TOKEN` etc. may leak in, causing dual login with the same bot token.
> `node --env-file=.env` does not overwrite existing environment variables, so values set by pm2 take precedence.

## Docker Deployment

Run in a container-isolated environment. Three containers are available:

| Container   | Dockerfile       | Purpose                                                                     |
| ----------- | ---------------- | --------------------------------------------------------------------------- |
| `xangi`     | `Dockerfile`     | Lightweight (Claude Code / Codex / Cursor CLI / Grok CLI / Antigravity CLI) |
| `xangi-max` | `Dockerfile.max` | Full version (uv + Python support, for Local LLM)                           |
| `xangi-gpu` | `Dockerfile.gpu` | GPU version (CUDA + PyTorch, for image generation / audio processing)       |

### Claude Code Backend

```bash
docker compose up xangi -d --build

# Claude Code authentication
docker compose exec xangi claude
```

`docker-compose.yml` sets `restart: unless-stopped`. Unless you explicitly stop the service with `docker compose stop` / `docker compose down`, the xangi container will be restored when the Docker daemon starts. To start xangi after an OS reboot, enable auto-start for the Docker daemon on the host.

To run Claude Code with Anthropic API-key billing, set `ANTHROPIC_API_KEY` in `.env`.
This value is passed only to the Claude Code child process and is not part of the general safe environment whitelist.
Set `CLAUDE_CODE_BARE=true` when you want to force API-key auth instead of OAuth/keychain auth.
Set `CLAUDE_CODE_MAX_BUDGET_USD` to cap API spend for each Claude Code print-mode run.

```env
AGENT_BACKEND=claude-code
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_CODE_BARE=true
CLAUDE_CODE_MAX_BUDGET_USD=0.25
```

### Local LLM Backend (Ollama)

An Ollama container is included, so there's no need to install Ollama on the host.

```bash
# Configure .env
AGENT_BACKEND=local-llm
LOCAL_LLM_MODEL=nemotron-3-nano

# Start (ollama + xangi-max)
docker compose up xangi-max -d --build
```

### GPU Version (CUDA + Python + PyTorch)

PyTorch (CUDA-enabled) is available and also works on DGX Spark (ARM64).

```bash
# Start (xangi-gpu + ollama)
docker compose up xangi-gpu -d --build

# Claude Code authentication
docker compose exec xangi-gpu claude

# Verify GPU
docker compose exec xangi-gpu python3 -c "import torch; print(torch.cuda.is_available())"
```

> **Tip**: `xangi-gpu` is a superset of `xangi-max`. Use this when you need skills that require GPU/PyTorch (speech transcription, image generation, etc.).

### Docker Operations

```bash
# Stop
docker compose down

# Restart (e.g. after .env changes)
docker compose up xangi-max -d --force-recreate

# Check logs
docker compose logs -f xangi-max
```

`docker compose down` explicitly stops and removes the container, so it will not come back until you run `docker compose up ... -d` again. If you only want to pause it, use `docker compose stop`; resume with `docker compose start`.

### Workspace Mounting

| Environment | Variable          | Description                                                  |
| ----------- | ----------------- | ------------------------------------------------------------ |
| Local       | `WORKSPACE_PATH`  | Path used directly by the agent                              |
| Docker      | `XANGI_WORKSPACE` | Host-side path (mapped to `/workspace` inside the container) |

For Docker deployment, set `XANGI_WORKSPACE` in `.env`:

```bash
XANGI_WORKSPACE=/home/user/my-workspace
```

> **Warning: Do not use `WORKSPACE_PATH`.** It may conflict with host shell environment variables.

### Security

- Containers do **not have direct access** to the host network
- The Ollama container is isolated within the same docker network
- Environment variables passed to the AI agent are restricted via a whitelist (e.g. `DISCORD_TOKEN` is not accessible)

## Local LLM

xangi's Local LLM backend uses the OpenAI-compatible API (`/v1/chat/completions`). It supports Ollama, vLLM, and other OpenAI-compatible servers (LM Studio, llama.cpp, etc.).

### Local Execution (Ollama)

```bash
# Configure .env
AGENT_BACKEND=local-llm
LOCAL_LLM_MODEL=gpt-oss:20b
# LOCAL_LLM_BASE_URL=http://localhost:11434  # default
```

Works as-is if Ollama is running.

### vLLM (OpenAI-compatible High-Performance Server)

vLLM is a high-performance inference server that provides an OpenAI-compatible API. It's well-suited for serious deployments — large models, long contexts, and MTP (Multi-Token Prediction) drafters — that go beyond what Ollama covers.

#### Launch Example (Gemma 4 26B-A4B-NVFP4 + MTP)

```bash
vllm serve nvidia/Gemma-4-26B-A4B-NVFP4 \
  --host 0.0.0.0 --port 8001 \
  --served-model-name gemma-4-26b-a4b \
  --max-num-batched-tokens 131072 \
  --max-model-len 131072 \
  --gpu-memory-utilization 0.85 \
  --kv-cache-dtype fp8 \
  --enable-auto-tool-choice --tool-call-parser gemma4 \
  --speculative-config '{"method":"mtp","num_speculative_tokens":2,"model":"google/gemma-4-26B-A4B-it-assistant"}'
```

#### Connection Settings (.env)

```bash
AGENT_BACKEND=local-llm
LOCAL_LLM_BASE_URL=http://localhost:8001
# From Docker: http://host.docker.internal:8001
LOCAL_LLM_MODEL=gemma-4-26b-a4b
LOCAL_LLM_NUM_CTX=131072  # Match vLLM's --max-model-len
```

#### Tuning Guide

| Option                                                   | Recommended               | Notes                                                                                                                          |
| -------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `--max-model-len`                                        | `131072`                  | Stable handling of long prompts such as full arxiv papers (~70k tokens) or site-patrol. 65536 isn't enough to fit a full paper |
| `--kv-cache-dtype`                                       | `fp8`                     | Context-wide expansion enlarges the KV cache; fp8 compression absorbs this. Plenty of headroom on a GB10 80GiB-class GPU       |
| `--gpu-memory-utilization`                               | `0.85`                    | 0.6 starves the KV cache; 0.85 is stable                                                                                       |
| `--max-num-batched-tokens`                               | Same as `--max-model-len` | Batching cap                                                                                                                   |
| `--enable-auto-tool-choice` `--tool-call-parser <model>` | Model-dependent           | Enables tool calling. Gemma 4 uses the `gemma4` parser                                                                         |
| `--speculative-config` (MTP)                             | Model-dependent           | Specify when using an MTP drafter. Improves response latency                                                                   |

`LOCAL_LLM_NUM_CTX` is the client-side cap on the xangi side. If it doesn't match vLLM's `--max-model-len`, xangi will truncate the prompt first and you'll lose the benefit of the wider window.

#### Verifying

```bash
# Model list (vLLM)
curl -s http://localhost:8001/v1/models | jq '.data[] | {id, max_model_len}'

# From Discord
/backend list  # Shows the model list on the server side (supports both Ollama and vLLM)
/backend show  # Shows detailed Local LLM settings for the current channel
```

### Logs

All backends save per-session transcript logs (`logs/sessions/<appSessionId>.jsonl`). Prompts, responses, and errors are recorded in per-session JSONL files.

For Docker deployment, see the [Docker Deployment](#docker-deployment) section.

### Individual Feature Control

Each Local LLM feature can be toggled independently via environment variables.

```bash
# .env — Example: disable only tools
LOCAL_LLM_TOOLS=false

# Example: chat-only bot (all off)
LOCAL_LLM_TOOLS=false
LOCAL_LLM_SKILLS=false
LOCAL_LLM_XANGI_COMMANDS=false

# Example: chat with triggers
LOCAL_LLM_TOOLS=false
LOCAL_LLM_SKILLS=false
LOCAL_LLM_XANGI_COMMANDS=false
LOCAL_LLM_TRIGGERS=true
```

| Variable                   | Description                                                         | Default |
| -------------------------- | ------------------------------------------------------------------- | ------- |
| `LOCAL_LLM_TOOLS`          | Tool execution (exec/read/write/edit/glob/grep/send_file/web_fetch) | `true`  |
| `LOCAL_LLM_SKILLS`         | Skill list injection                                                | `true`  |
| `LOCAL_LLM_XANGI_COMMANDS` | XANGI_COMMANDS injection                                            | `true`  |
| `LOCAL_LLM_TRIGGERS`       | Triggers (!commands)                                                | `false` |

`LOCAL_LLM_MODE` presets are also available (individual settings take priority):

- `agent` (default) — tools / skills / xangi_commands ON, triggers OFF
- `chat` — all off (pure chitchat bot)
- `lite` — tools / xangi_commands / triggers ON, skills OFF (chatty bot that can still operate Discord/Slack)

Workspace context (AGENTS.md, etc.) is always injected regardless of settings.

### Triggers (Custom Tools)

Add custom tools to the LLM by placing shell scripts in the `triggers/` directory. Enable with `LOCAL_LLM_TRIGGERS=true`.

The LLM calls triggers via function calling, and handler.sh is executed to return results.

#### Setup

Create a `triggers/` directory in your workspace with subdirectories for each command:

```
workspace/
  triggers/
    weather/
      trigger.yaml    # Trigger definition
      handler.sh      # Handler script
    search/
      trigger.yaml
      handler.sh
```

#### trigger.yaml Format

```yaml
name: weather
description: 'Get weather forecast (e.g., weather Tokyo)'
handler: handler.sh
```

| Field         | Required | Description                                                      |
| ------------- | -------- | ---------------------------------------------------------------- |
| `name`        | Yes      | Tool name (used by LLM in function calling)                      |
| `description` | No       | Tool description (included in the tool definition passed to LLM) |
| `handler`     | Yes      | Handler script filename                                          |

#### Handler Specification

- Executed as `bash handler.sh [args...]` with workspace root as `cwd`
- Arguments are passed from the LLM's function calling `args` parameter
- Timeout: `EXEC_TIMEOUT_MS` (default 120 seconds)
- `stdout` content is returned to the LLM, which generates a natural language response

#### How It Works

1. On startup, xangi scans `triggers/` and auto-generates tool definitions
2. Triggers are registered as custom tools for the LLM
3. LLM calls the tool via function calling
4. handler.sh is executed and results are returned to the LLM
5. LLM generates a natural response based on the results

#### Notes

- Works in modes with tools enabled (lite/agent)
- Restart xangi after adding new triggers

### Multimodal (Image Input)

The Local LLM backend supports image input. When you send a message with an image attachment via Discord/Slack, the image content is passed to the LLM for analysis and description.

#### Supported Image Formats

JPEG (.jpg, .jpeg), PNG (.png), GIF (.gif), WebP (.webp)

#### Supported LLM Servers

- **Ollama** — Sends images via the `images` field (base64 format) in `/api/chat`
- **OpenAI-compatible API (vLLM, etc.)** — Sends images via array format (`text` + `image_url`) in `messages[].content`

If the endpoint URL contains port `11434` or `ollama`, Ollama format is used; otherwise, OpenAI-compatible format is used.

#### Example

```
@xangi Describe this image
(attach an image)
```

Non-image files (PDF, text, etc.) are still passed as file paths to the prompt as before.

#### Notes

- A multimodal-capable model (e.g. `llava`, `llama3.2-vision`, etc.) is required
- Images are sent as-is in base64 encoding (no resizing)
- When no image is present, it works with text only as before (backward compatible)

### Session Management and Auto-Retry

The Local LLM backend maintains sessions (conversation history) per channel. When errors caused by session history occur (e.g. context length exceeded, malformed message format), the session is automatically cleared and retried with only the last user message.

### Error Handling

| Error                       | Message                                                                   |
| --------------------------- | ------------------------------------------------------------------------- |
| ECONNREFUSED / fetch failed | Could not connect to the LLM server. Please verify the server is running. |
| timeout / aborted           | LLM response timed out. Please try again later.                           |
| 401 / 403                   | Authentication to the LLM server failed. Please check your API key.       |
| 429                         | LLM server rate limit reached. Please try again later.                    |
| 500 / 502 / 503             | An internal error occurred on the LLM server. Please try again later.     |
| Other                       | LLM error: (original error message)                                       |

### Example Models

| Model              | Size  | Features                             | Notes                 |
| ------------------ | ----- | ------------------------------------ | --------------------- |
| `gpt-oss:20b`      | 13GB  | MoE, high quality, tool call support | Recommended           |
| `gpt-oss:120b`     | 65GB  | MoE (active 12B), highest quality    | Requires large memory |
| `nemotron-3-nano`  | 24GB  | Mamba hybrid, fast                   |                       |
| `nemotron-3-super` | 86GB  | Mamba hybrid, high accuracy          | Requires large memory |
| `qwen3.5:9b`       | 6.6GB | Lightweight, Thinking support        |                       |
| `Qwen3.5-27B-FP8`  | 29GB  | High-precision tool calls, ~6 tok/s  | vLLM recommended      |

Other models available via Ollama/vLLM are also supported.

## Workspace Hooks (Stop Hook)

A mechanism that inserts an external verification process (hook) at the end of each agent-loop turn. The contract is compatible with the Stop hooks of Claude Code / Codex CLI, so the same hook script can be shared across runtimes. Currently only the turn end (`Stop` event) of the Local LLM backend is supported.

Example use case: block a response that promises "I'll check and report later" without actually calling the schedule registration tool, and feed back a reminder to register (preventing run-and-forget).

### Configuration

Hooks are enabled by default. Just place `hooks/hooks.json` in your workspace and it works (no-op if absent) — the same "place it and it works" convention as skills / triggers.

```bash
# Only if you want to temporarily disable hooks (kill switch)
# XANGI_HOOKS_ENABLED=false
# Only if you want to relocate the config file (default: <workspace>/hooks/hooks.json)
# XANGI_HOOKS_FILE=/path/to/hooks.json
```

Place `hooks/hooks.json` in your workspace:

```json
{
  "hooks": {
    "Stop": [{ "command": "python3 hooks/check-promise/hook.py", "timeoutMs": 10000 }]
  }
}
```

### Hook Contract (Claude Code Compatible)

The hook is executed as a command at turn end (cwd = workspace) and receives JSON on stdin:

```json
{
  "hook_event_name": "Stop",
  "session_id": "...",
  "cwd": "/path/to/workspace",
  "stop_hook_active": false,
  "last_assistant_message": "(final response text of this turn)",
  "channel_id": "...",
  "tools_called": ["exec", "schedule_add"]
}
```

`channel_id` / `tools_called` are xangi extensions. The hook can directly check "which tools were actually executed this turn" without parsing a transcript.

Ways to block (either works):

- exit 0 + stdout `{"decision": "block", "reason": "..."}` (reason required)
- exit 2 + reason text on stderr

Anything else (no output / non-JSON / other exit codes / timeout / spawn failure) passes through (fail-open). Hook failures never stall the main response.

### What Happens When Blocked

1. The hook's reason is injected into the LLM as a system message tagged `[STOP HOOK FEEDBACK]`
2. One (and only one) continuation round runs in the same session (tool calls allowed — e.g. the model can call `schedule_add` here to make its promise real)
3. The final response returned to the user is the original response concatenated with the continuation round's response
4. The continuation round's result is not re-checked (one nudge per turn, preventing block loops)

### Environment Variables

| Variable              | Default                        | Description                                              |
| --------------------- | ------------------------------ | -------------------------------------------------------- |
| `XANGI_HOOKS_ENABLED` | `true`                         | Set `false` to disable the hooks mechanism (kill switch) |
| `XANGI_HOOKS_FILE`    | `<workspace>/hooks/hooks.json` | Path to the hooks config file                            |

### Enabling / Disabling

- Global: `XANGI_HOOKS_ENABLED` (default `true`; set `false` as a kill switch to pause hooks while keeping `hooks.json` in place)
- Mode-linked: in tool-disabled mode (`chat`), the gate itself is skipped automatically, because the LLM has no means (tool calls such as `schedule_add`) to act on the feedback in the continuation round
- Per channel: switching a channel to `chat` via `CHANNEL_OVERRIDES`' `localLlmMode` or `/llmmode` disables hooks for that channel only

### Limitations

- Only the `Stop` event is supported (`PreToolUse` etc. are future extensions)
- Only the `local-llm` backend is supported. For the `claude-code` / `codex` backends, use each CLI's own hooks mechanism (Claude Code's `.claude/settings.json` / Codex's lifecycle hooks)
- Multiple hooks run sequentially in registration order; the first block wins
- Hook stdout/stderr capture is limited to 64KB; timeout defaults to 10s with a 60s cap

## Tool Trajectory Logger

Structured observability log of Local LLM tool usage (drift / loop / tool_search adoption mistakes). Runs independently from the existing `transcript-logger` (conversation source of truth) and is fully isolated from session restore.

### Output Location

```
logs/tool-trajectory/<appSessionId>.jsonl
```

One line per event. Lives alongside but separate from `logs/sessions/<appSessionId>.jsonl` (transcript), so the two never interfere.

### Event Kinds

| kind            | what's recorded                                                                     |
| --------------- | ----------------------------------------------------------------------------------- |
| `session_start` | backend / model / baseUrl / features / logger config (once per appSession)          |
| `tool_call`     | tool_name / args_sanitized / result_truncated / duration_ms / status / round        |
| `tool_search`   | query / candidates_top5 / activated_tools / activated_skills                        |
| `drift_rescue`  | raw_text_head / parsed_name / safety_verdict / executed                             |
| `loop_detected` | loop_kind (exact / similar / idempotent_cache_hit) / signature / action             |
| `runner_event`  | streaming_hold_buffer_drop / context_prune / session_retry / idempotent_cache_store |

Common fields on every event: `ts` / `event_id` / `kind` / `schema_version=1` / `appSessionId` / `seq` / `turn_index` / `round` / `platform` / `backend` / `model` / `channelId_hash`.

### Mandatory Sanitization

Designed so the logs remain safe to publish (OSS):

- Secret-like keys (`token` / `apiKey` / `bearer` / `cookie` / `authorization` / `password` etc.) → replaced with literal `[REDACTED_SECRET]`
- Discord channelId / userId / LINE userId → salted sha256 hash (12 chars, `h_` prefix)
- Absolute home-prefix paths → replaced with `$HOME`
- URL query values matching secret-like keys → redacted
- Long args / results → head/tail truncation (defaults: args 8KB, result 16KB, drift raw 2KB)

### Retention

- Disabled by default — pruning only happens when TTL or size cap is explicitly set via env
- The logger preserves raw observation data by default; auto-deletion is opt-in
- When TTL days is set via env, files older than that are pruned at startup
- When size cap MB is set via env, oldest files are removed once total exceeds the cap
- One session = one file (no rotation)

### Configuration

| env                                    | default              | description                                                                                             |
| -------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------- |
| `XANGI_TOOL_TRAJECTORY_LOG`            | `true`               | `false` disables the logger entirely (no files created)                                                 |
| `TOOL_TRAJECTORY_LOG_HASH_SALT`        | (random per startup) | Fixed salt for Discord/LINE ID hashing. Specify only if you need ID correlation across process restarts |
| `TOOL_TRAJECTORY_LOG_MAX_ARGS_CHARS`   | `8192`               | Args truncation limit                                                                                   |
| `TOOL_TRAJECTORY_LOG_MAX_RESULT_CHARS` | `16384`              | Tool result truncation limit                                                                            |
| `TOOL_TRAJECTORY_LOG_RETENTION_DAYS`   | (unset)              | No pruning. When set, acts as TTL in days                                                               |
| `TOOL_TRAJECTORY_LOG_SIZE_CAP_MB`      | (unset)              | No size cap. When set, total size cap (MB) for pruning                                                  |

### Fail-safe

Writes that fail are reported via `console.warn` only — the logger never throws. JSONL corruption, full disk, etc. won't crash the runner. Session restore never reads `logs/tool-trajectory/`, so logger-side failures cannot affect conversation continuity.

### Design Intent

- Target: how the multi-layer defense (loop / idempotent cache / streaming hold buffer / pseudo tool_call rescue / context prune — the 5+1 mechanisms) fires for Local LLM, tool_search adoption results, and the breakdown of drift_rescue safety verdicts.
- The runner itself only emits observation events; any dataset conversion or downstream analysis is left to separate tooling that consumes this JSONL.

## Security

### Environment Variable Whitelist

Environment variables passed to the AI agent (CLI spawn / Local LLM exec) are managed in `src/safe-env.ts`. Only variables listed in the whitelist are passed; secrets like `DISCORD_TOKEN` are not accessible to the AI.

**Allowed variables:** `PATH`, `HOME`, `USER`, `SHELL`, `LANG`, `LC_*`, `TERM`, `TMPDIR`, `TZ`, `NODE_ENV`, `NODE_PATH`, `WORKSPACE_PATH`, `AGENT_BACKEND`, `AGENT_MODEL`, `SKIP_PERMISSIONS`, `DATA_DIR`, `XANGI_TOOL_SERVER`, `XANGI_CHANNEL_ID`

`ANTHROPIC_API_KEY`, `CURSOR_API_KEY`, and `XAI_API_KEY` are not part of the general whitelist. They are passed only to Claude Code, Cursor CLI, and Grok CLI child processes respectively.

**Not passed (examples):** `DISCORD_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `LOCAL_LLM_API_KEY`, `GH_TOKEN`

To modify the whitelist, edit `ALLOWED_ENV_KEYS` in `src/safe-env.ts`.

## Environment Variables Reference

### First-turn history prefetch (Discord / Slack / Web)

| Variable                     | Description                                                        | Default |
| ---------------------------- | ------------------------------------------------------------------ | ------- |
| `HISTORY_PREFETCH_ENABLED`   | Prefetch recent history before the first provider turn             | `true`  |
| `HISTORY_PREFETCH_COUNT`     | Number of messages to prefetch (`1` to `100`)                       | `10`    |

Prefetch runs only when no provider session ID exists. Continuing turns use the provider session's existing context. When disabled, xangi does not inject first-turn history.

- Discord channel: the latest messages before the current message
- New Discord thread: zero prior messages; the current message is the thread starter
- Existing Discord thread: recent thread messages plus the separately injected parent-channel starter
- Slack channel: recent messages from `conversations.history`
- New Slack thread: zero prior messages
- Existing Slack thread: the root and recent replies from `conversations.replies`, excluding the current message
- Web Chat: recent messages from the current pane's session JSONL; a new pane has zero prior messages

### Discord

| Variable                             | Description                                                                                                        | Default      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------ |
| `DISCORD_TOKEN`                      | Discord Bot Token                                                                                                  | **Required** |
| `DISCORD_ALLOWED_USER`               | Allowed user ID (comma-separated for multiple, `*` to allow all)                                                   | **Required** |
| `DISCORD_REPLY_IN_THREAD`            | Post replies into a per-message thread instead of the channel                                                      | `false`      |
| `DISCORD_STREAMING`                  | Streaming output                                                                                                   | `true`       |
| `DISCORD_SHOW_THINKING`              | Show thinking process                                                                                              | `true`       |
| `DISCORD_SHOW_BUTTONS`               | Show Stop/New Session buttons                                                                                      | `true`       |
| `DISCORD_REPLY_SUGGESTIONS`          | Show a user-only `返信候補` button for reply suggestions                                                           | `false`      |
| `DISCORD_REPLY_SUGGESTIONS_COUNT`    | Number of reply suggestions (1-5)                                                                                  | `3`          |
| `DISCORD_TOOL_HISTORY_MODE`          | Tool-use history display (`button` / `inline` / `off`)                                                             | `button`     |
| `DISCORD_SHOW_TOOL_BUTTON`           | Show the Tools button in `button` mode                                                                             | `true`       |
| `DISCORD_SHOW_LIVE_TOOL_USE`         | Show raw tool history while running                                                                                | `true`       |
| `TOOL_HISTORY_MAX_LINES`             | Max tool history lines shown (older lines collapse into a `… (+N 件省略)` summary line; `0` or less for unlimited) | `10`         |
| `DISCORD_SHOW_TOOL_USE`              | Compatibility setting. `false` maps to `off`, `true` maps to `inline`                                              | -            |
| `DISCORD_COMPLETION_NOTIFY`          | Send a separate completion notification after long Discord turns (`off` / `message` / `mention`)                   | `message`    |
| `DISCORD_COMPLETION_NOTIFY_AFTER_MS` | Minimum elapsed time before sending a completion notification (ms)                                                 | `10000`      |
| `ALLOW_AUTOREPLY_COMMAND`            | Enable `/autoreply` command                                                                                        | `true`       |
| `XANGI_SELF_LIFECYCLE`               | Allow xangi to request its own restart (`off` / `restart-only`)                                                    | `off`        |
| `RESPOND_TO_BOTS`                    | Whitelist of bot IDs to respond to (`*` for all bots)                                                              | -            |
| `RESPOND_TO_BOTS_ENABLED`            | Toggle bot-to-bot reply ON/OFF (`/respondtobots` switches at runtime)                                              | `false`      |
| `RESPOND_TO_BOTS_MAX_CONSECUTIVE`    | Max consecutive replies to the same bot (0 = unlimited)                                                            | `3`          |
| `ALLOW_RESPOND_TO_BOTS_COMMAND`      | Enable `/respondtobots` command                                                                                    | `true`       |
| `ALLOW_THREAD_MODE_COMMAND`          | Enable `/threadmode` command                                                                                       | `true`       |
| `ALLOW_LLM_MODE_COMMAND`             | Enable `/llmmode` command (Local LLM mode switcher)                                                                | `true`       |
| `INJECT_CHANNEL_TOPIC`               | Inject channel topic into prompt                                                                                   | `true`       |
| `INJECT_TIMESTAMP`                   | Inject current time into prompt                                                                                    | `true`       |

### AI Agent

| Variable                     | Description                                                                                                                    | Default                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| `AGENT_BACKEND`              | Backend (`claude-code` / `codex` / `cursor` / `grok` / `local-llm`)                                                            | `claude-code`           |
| `AGENT_MODEL`                | Model to use                                                                                                                   | -                       |
| `WORKSPACE_PATH`             | Working directory (local execution)                                                                                            | `./workspace`           |
| `XANGI_WORKSPACE`            | Host-side workspace path (Docker execution)                                                                                    | `./workspace`           |
| `SKIP_PERMISSIONS`           | Skip permissions by default (avoids deadlocks for non-interactive chat platforms)                                              | `true`                  |
| `TIMEOUT_MS`                 | Initial request timeout (milliseconds)                                                                                         | `1800000`               |
| `XANGI_TOOL_SERVER_PORT`     | Fixed port for the internal tool server. When unset, the previous port is reused (auto-assign if busy)                         | reuse last port         |
| `XANGI_CONFIG_STRICT`        | Escalate invalid env values (non-numeric, out of range, enum typos) to startup errors. Default is warn + fall back to defaults | `false`                 |
| `TIMEOUT_MAX_MS`             | Absolute upper limit for timeout extension (milliseconds)                                                                      | `36000000`              |
| `TIMEOUT_EXTEND_ENABLED`     | Enable / disable the `延長` button                                                                                             | `true`                  |
| `ALLOWED_BACKENDS`           | Allowed backends for `/backend` switching (comma-separated). If unset, all backends are allowed                                | all backends            |
| `ALLOWED_MODELS`             | Allowed models for `/backend` switching (comma-separated)                                                                      | -                       |
| `CHANNEL_OVERRIDES`          | Per-channel backend settings (JSON). Discord threads inherit the parent channel's entry                                                   | -                       |
| `ANTHROPIC_API_KEY`          | Anthropic API key passed only to the Claude Code backend                                                                       | -                       |
| `CLAUDE_CODE_BARE`           | Pass `--bare` to Claude Code and force API-key auth instead of OAuth/keychain auth                                             | `false`                 |
| `CLAUDE_CODE_MAX_BUDGET_USD` | Pass `--max-budget-usd` to Claude Code to cap API spend                                                                        | -                       |
| `CURSOR_API_KEY`             | API key passed only to the Cursor CLI backend                                                                                  | -                       |
| `CURSOR_FORCE`               | Pass `--force` to Cursor CLI unless explicitly set to `false`                                                                  | `true`                  |
| `CURSOR_TRUST_WORKSPACE`     | Pass `--trust` to Cursor CLI unless explicitly set to `false`                                                                  | `true`                  |
| `XAI_API_KEY`                | API key passed only to the Grok CLI backend (not required when `grok login` is already configured)                             | -                       |
| `PERSISTENT_MODE`            | Persistent process mode                                                                                                        | `true`                  |
| `MAX_PROCESSES`              | Maximum concurrent processes                                                                                                   | `10`                    |
| `IDLE_TIMEOUT_MS`            | Auto-terminate idle processes after                                                                                            | `1800000`               |
| `DATA_DIR`                   | Data storage directory (schedules, sessions, etc.)                                                                             | `WORKSPACE_PATH/.xangi` |
| `GH_TOKEN`                   | GitHub CLI token                                                                                                               | -                       |

### Workspace Hooks

| Variable              | Description                                                                                              | Default                        |
| --------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `XANGI_HOOKS_ENABLED` | Run Stop hooks at turn end (see [Workspace Hooks](#workspace-hooks-stop-hook)). `false` is a kill switch | `true`                         |
| `XANGI_HOOKS_FILE`    | Path to the hooks config file                                                                            | `<workspace>/hooks/hooks.json` |

### Tool Approval

| Variable               | Description                                              | Default |
| ---------------------- | -------------------------------------------------------- | ------- |
| `APPROVAL_ENABLED`     | Require Discord/Slack approval before dangerous commands | `false` |
| `APPROVAL_SERVER_PORT` | Approval server listen port                              | `18181` |

### Web Chat UI

| Variable                   | Description                                                                                                                                                                                           | Default             |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `WEB_CHAT_ENABLED`         | Enable Web Chat UI. `true` exposes `http://localhost:<WEB_CHAT_PORT>`                                                                                                                                 | `false`             |
| `WEB_REPLY_SUGGESTIONS`    | Show collapsed reply suggestions below responses                                                                                                                                                     | `false`             |
| `WEB_REPLY_SUGGESTIONS_COUNT` | Number of reply suggestions (1-5)                                                                                                                                                                 | `3`                 |
| `WEB_CHAT_PORT`            | Web Chat UI port                                                                                                                                                                                      | `18888`             |
| `WEB_CHAT_HOST`            | Bind host. `0.0.0.0` exposes on all interfaces. The Web UI has no auth, so set `127.0.0.1` to restrict to loopback and reach it only via SSH port-forward, Tailscale, etc.                            | `0.0.0.0`           |
| `WEB_CHAT_UPLOAD_ACCEPT`   | Upload allowlist (HTML `accept` syntax). Empty = allow all. `.ext` entries are also enforced server-side                                                                                              | (unset / allow all) |
| `WEB_CHAT_DOWNLOAD_ACCEPT` | Download allowlist of extensions (e.g. `.html,.txt,.md`). Empty = allow all. Known extensions are served inline with proper Content-Type; unknown ones fall back to `Content-Disposition: attachment` | (unset / allow all) |

When Web Chat is enabled, the same server also exposes `http://localhost:<WEB_CHAT_PORT>/monitor`. `/monitor` is a read-only session monitor that lists Web / Discord / Slack sessions with the current turn summary, recent tool lines, elapsed seconds, and runner state.

### External Event Stream and Device Input

xangi exposes response lifecycle events through pull SSE (`GET /api/events/stream`) and small write endpoints for external UI clients (`POST /api/pet/inbox`, `/api/device/inbox`, `/api/terminal/inbox`). See [External Event Stream](events.md) for schemas and examples.

| Variable                     | Description                                                                         | Default |
| ---------------------------- | ----------------------------------------------------------------------------------- | ------- |
| `XANGI_EVENTS_ENABLED`       | Set to `false` to disable SSE event streaming (connections return 503)              | `true`  |
| `XANGI_INSTANCE_ID`          | Stable instance identifier. Auto-derived from hostname + `DATA_DIR` hash when unset | `auto`  |
| `XANGI_PET_INBOX_ENABLED`    | Set to `false` to disable pet/device inbox writes                                   | `true`  |
| `XANGI_PET_INBOX_TOKEN`      | Fallback bearer token for pet/device/terminal inbox routes                          | (unset) |
| `XANGI_DEVICE_INBOX_ENABLED` | Set to `false` to disable `/api/device/inbox` and `/api/terminal/inbox`             | `true`  |
| `XANGI_DEVICE_INBOX_TOKEN`   | Bearer token for device/terminal routes; falls back to `XANGI_PET_INBOX_TOKEN`      | (unset) |

### Even Terminal Compatibility API

xangi can also act as a host server for Even G2 Terminal mode (`@evenrealities/even-terminal` compatible). It exposes `/api/prompt`, `/api/events`, `/api/messages`, and related endpoints on the same Web Chat HTTP server. See [External Event Stream#Even Terminal Compatibility API](events.md#even-terminal-compatibility-api).

The Even UI only offers `claude` and `codex` provider labels. xangi accepts those labels for protocol compatibility, but the actual backend is still selected by `AGENT_BACKEND`. To use a different backend / model / Local LLM mode only for Even Terminal traffic, set `XANGI_EVEN_TERMINAL_BACKEND`, `XANGI_EVEN_TERMINAL_MODEL`, and `XANGI_EVEN_TERMINAL_LOCAL_LLM_MODE`. Per-session `CHANNEL_OVERRIDES` entries for `web-chat:<appSessionId>` take precedence over these Even Terminal defaults.

| Variable                             | Description                                                                                                                                | Default                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| `XANGI_EVEN_TERMINAL_TOKEN`          | Dedicated token for the Even Terminal compatibility API. Falls back to `XANGI_DEVICE_INBOX_TOKEN`, then `XANGI_PET_INBOX_TOKEN` when unset | (unset)                         |
| `XANGI_EVEN_TERMINAL_BACKEND`        | Backend default used only for Even Terminal traffic (`claude-code` / `codex` / `cursor` / `grok` / `local-llm`)                            | `AGENT_BACKEND`                 |
| `XANGI_EVEN_TERMINAL_MODEL`          | Model default used only for Even Terminal traffic                                                                                          | `AGENT_MODEL` / backend default |
| `XANGI_EVEN_TERMINAL_LOCAL_LLM_MODE` | Local LLM mode default used only for Even Terminal traffic (`agent` / `lite` / `chat`)                                                     | `LOCAL_LLM_MODE` / `agent`      |

### Scheduler

| Variable            | Description          | Default |
| ------------------- | -------------------- | ------- |
| `SCHEDULER_ENABLED` | Enable scheduler     | `true`  |
| `STARTUP_ENABLED`   | Enable startup tasks | `true`  |

### GitHub App Authentication (Optional)

When GitHub App settings are configured, installation tokens are auto-generated on each `gh` CLI execution. No PAT or `gh auth login` needed.

| Variable                      | Description           |
| ----------------------------- | --------------------- |
| `GITHUB_APP_ID`               | GitHub App ID         |
| `GITHUB_APP_INSTALLATION_ID`  | Installation ID       |
| `GITHUB_APP_PRIVATE_KEY_PATH` | Private key file path |

Without these settings, existing `gh` authentication (`gh auth login` / `GH_TOKEN`) is used as-is.

**Docker:** The private key is auto-mounted to `/secrets/github-app.pem`. Set the host-side path in `.env`.

**`gh` / `git` wrappers:** When GitHub App authentication is enabled, xangi generates `/tmp/xangi-gh-wrapper/gh` and `/tmp/xangi-gh-wrapper/git`, then pins that directory to the front of the `PATH` passed to AI agents. It also re-applies the same setting through `BASH_ENV`, so non-interactive shells are less likely to rebuild `PATH` back to the regular `gh` / `git`.

The `gh` wrapper fetches a short-lived installation token from `/github-token` on each run and passes it to the real `gh` as `GH_TOKEN`. The `git` wrapper bypasses the existing `gh auth git-credential` helper and returns an installation token from `/github-token` as the `x-access-token` user only when Git asks for GitHub HTTPS credentials. SSH remotes are not affected.

**Runtime check:**

```bash
curl -i "$XANGI_TOOL_SERVER/github-token"
```

- `200 OK`: GitHub App authentication is enabled
- `404 {"error":"GitHub App is not configured"}`: this is a configuration or restart issue, not a missing implementation. Set `GITHUB_APP_*` in `.env`, then restart xangi
- `500`: token generation failed due to the private key, App ID, Installation ID, or GitHub API call

**Security:**

- The private key is loaded into memory at startup and is not directly accessible as a file by the AI agent
- Token generation is performed via the tool-server's HTTP endpoint (`/github-token`), and the AI agent can only obtain short-lived installation tokens (valid for 1 hour)
- If token generation fails, it does NOT fall back to PAT — it errors out

### Cursor CLI (when `AGENT_BACKEND=cursor`)

The Cursor CLI backend uses the `cursor-agent` command. Non-interactive runs use `cursor-agent -p ... --output-format json`; streaming uses `--output-format stream-json --stream-partial-output`.

Set `CURSOR_API_KEY` when Cursor CLI automation needs API-key authentication. This value is passed only to the Cursor CLI child process.

The Cursor CLI backend passes `--trust` by default so non-interactive xangi runs do not stop on a workspace trust prompt. Set `CURSOR_TRUST_WORKSPACE=false` when running in an untrusted workspace.

The Cursor CLI backend also passes `--force` by default, matching xangi's default `SKIP_PERMISSIONS=true` behavior for Codex / Claude Code and avoiding permission waits in non-interactive chat runs. Set `CURSOR_FORCE=false` for interactive use or untrusted workspaces.

### Grok CLI (when `AGENT_BACKEND=grok`)

The Grok CLI backend uses xAI's `grok` command. Non-interactive runs use `grok --no-auto-update -p ... --output-format json`; streaming uses `--output-format streaming-json`.

Authentication depends on a local `grok login` session or `XAI_API_KEY`. `XAI_API_KEY` is passed only to the Grok CLI child process.

When `SKIP_PERMISSIONS=true` (the default), xangi passes `--always-approve` to avoid tool approval prompts in non-interactive chat runs. This is intended for personal use in trusted workspaces.

### Antigravity CLI (`AGENT_BACKEND=antigravity`)

The Antigravity backend uses Google's `agy` command. Install it with `curl -fsSL https://antigravity.google/cli/install.sh | bash` and complete the first-run `agy` authentication flow.

Non-interactive execution uses `agy --print-timeout <timeout> --output-format json -p ...`. xangi reads `status`, `response`, and `conversation_id` from Agy CLI 1.1.2 final JSON and returns `conversation_id` as the provider session. Set `ANTIGRAVITY_PRINT_TIMEOUT` (default: `5m`) to control agy's own print-mode timeout. xangi passes `--model` when `AGENT_MODEL` is set and `--conversation` when a provider session id is available. When a workdir is configured, it also passes `--add-dir .` for that same child-process cwd.

If an older agy explicitly reports that `--output-format` is unsupported, xangi retries once in legacy plain-output mode and caches that mode for the runner. It does not retry ordinary execution errors such as timeouts, authentication or quota errors, or an invalid model.

If agy exits successfully with empty stdout, xangi surfaces timeout, quota, authentication, or other details written to stderr as the error message.

When `SKIP_PERMISSIONS=true` (the default), xangi passes `--dangerously-skip-permissions` to avoid blocking on permission prompts in non-interactive chat operation. Use this only for trusted personal workspaces.

True incremental Antigravity streaming (`stream-json`) is not implemented. `runStream` emits the final response once.

### Local LLM (when `AGENT_BACKEND=local-llm`)

| Variable                                | Description                                                                            | Default                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `LOCAL_LLM_BASE_URL`                    | LLM server URL                                                                         | `http://localhost:11434`                                         |
| `LOCAL_LLM_MODE`                        | Preset (`agent` / `chat` / `lite`)                                                     | `agent`                                                          |
| `LOCAL_LLM_TOOLS`                       | Tool execution                                                                         | `true`                                                           |
| `LOCAL_LLM_SKILLS`                      | Skill list injection                                                                   | `true`                                                           |
| `LOCAL_LLM_XANGI_COMMANDS`              | XANGI_COMMANDS injection                                                               | `true`                                                           |
| `LOCAL_LLM_TRIGGERS`                    | Triggers (!commands)                                                                   | `false`                                                          |
| `LOCAL_LLM_MODEL`                       | Model name                                                                             | -                                                                |
| `LOCAL_LLM_API_KEY`                     | API key (if required by vLLM, etc.)                                                    | -                                                                |
| `LOCAL_LLM_THINKING`                    | Enable thinking model reasoning                                                        | `true`                                                           |
| `LOCAL_LLM_MAX_TOKENS`                  | Maximum tokens (per-request `max_tokens`)                                              | `8192`                                                           |
| `LOCAL_LLM_NUM_CTX`                     | Context window size (Ollama; also used as the basis for context budget calculation)    | Model default                                                    |
| `LOCAL_LLM_TEMPERATURE`                 | Sampling temperature (0 for deterministic; useful to suppress agent-mode format drift) | Model default                                                    |
| `LOCAL_LLM_CONTEXT_MAX_CHARS`           | Maximum history characters (explicit; auto-derived from `LOCAL_LLM_NUM_CTX` if unset)  | Auto-derived                                                     |
| `LOCAL_LLM_SYSTEM_PROMPT_BUDGET_TOKENS` | Tokens reserved for the system prompt (used in derivation)                             | `8000`                                                           |
| `LOCAL_LLM_OUTPUT_BUDGET_TOKENS`        | Tokens reserved for one response (used in derivation)                                  | `4096`                                                           |
| `LOCAL_LLM_SAFETY_MARGIN_TOKENS`        | Safety margin tokens (used in derivation)                                              | `1000`                                                           |
| `LOCAL_LLM_CONTEXT_KEEP_LAST`           | Most recent N messages are never trimmed                                               | `10`                                                             |
| `LOCAL_LLM_TOOL_RESULT_MAX_CHARS`       | Max chars for in-context tool results (head/tail trim)                                 | `4000`                                                           |
| `LOCAL_LLM_MAX_SESSION_MESSAGES`        | Maximum number of messages kept per session                                            | `50`                                                             |
| `LOCAL_LLM_TOOL_SEARCH_ENABLED`         | Enable tool deferred loading (`tool_search`)                                           | `true`                                                           |
| `LOCAL_LLM_TOOL_SEARCH_LIMIT`           | Max tools returned per `tool_search` call                                              | `8`                                                              |
| `LOCAL_LLM_ALWAYS_LOADED_TOOLS`         | Always-loaded tool names (comma-separated). Tools not listed are deferred              | `read,write,edit,exec,glob,grep,send_file,web_fetch,tool_search` |
| `EXEC_TIMEOUT_MS`                       | Exec tool timeout (milliseconds)                                                       | `120000`                                                         |
| `WEB_FETCH_TIMEOUT_MS`                  | web_fetch tool timeout (milliseconds)                                                  | `15000`                                                          |
| `LOCAL_LLM_READ_MAX_BYTES`              | read tool file size limit (bytes)                                                      | `524288` (512KB)                                                 |
| `LOCAL_LLM_READ_JSON_MAX_BYTES`         | read tool JSON file size limit (bytes)                                                 | `5120` (5KB)                                                     |
| `LOCAL_LLM_WRITE_MAX_BYTES`             | write tool content size limit (bytes)                                                  | `524288` (512KB)                                                 |

### Slack

| Variable                           | Description                                                                                                |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `SLACK_BOT_TOKEN`                  | Slack Bot Token (xoxb-...)                                                                                 |
| `SLACK_APP_TOKEN`                  | Slack App Token (xapp-...)                                                                                 |
| `SLACK_ALLOWED_USER`               | Allowed user ID                                                                                            |
| `SLACK_AUTO_REPLY_CHANNELS`        | Channel IDs to respond without mention                                                                     |
| `SLACK_REPLY_IN_THREAD`            | Reply in threads (default: `true`)                                                                         |
| `SLACK_REPLY_IN_CHANNELS`          | Channel IDs to post replies directly in the channel even when thread replies are enabled (comma-separated) |
| `SLACK_COMPLETION_NOTIFY_AFTER_MS` | Minimum elapsed time before sending a completion notice for non-thread Slack turns (ms)                    | `10000` |
| `SLACK_REPLY_SUGGESTIONS`          | Show a user-only `返信候補` button for reply suggestions                                                   | `false` |
| `SLACK_REPLY_SUGGESTIONS_COUNT`    | Number of reply suggestions (1-5)                                                                          | `3`     |

## Running Multiple Instances

If you run multiple xangi instances on the same machine (e.g. one for production and one for development), **always give each instance its own `DATA_DIR`**. The default is `${WORKSPACE_PATH}/.xangi/`; sharing this between instances causes `sessions.json` to be overwritten back and forth, which can silently wipe out newly created sessions (because a long-running process keeps the stale in-memory list and writes it back).

If you run multiple instances under PM2, also give each instance a unique `XANGI_PROCESS_NAME`. `DATA_DIR` is the internal state namespace, `XANGI_INSTANCE_ID` is the logical ID for events and inter-instance-chat, and `XANGI_PROCESS_NAME` is the external name used by PM2 / service commands. In normal deployments, `XANGI_PROCESS_NAME` can be the same value as `XANGI_INSTANCE_ID`.

### Recommended layout

```bash
# Production
WORKSPACE_PATH=/home/user/ai-assistant-workspace
XANGI_INSTANCE_ID=xangi-prod
XANGI_PROCESS_NAME=xangi-prod
# DATA_DIR omitted → /home/user/ai-assistant-workspace/.xangi/

# Development (xangi-dev)
WORKSPACE_PATH=/home/user/ai-assistant-workspace
XANGI_INSTANCE_ID=xangi-dev
XANGI_PROCESS_NAME=xangi-dev
DATA_DIR=/home/user/xangi-dev/.xangi   # ← isolated explicitly
```

Sharing `WORKSPACE_PATH` itself is fine (you may want skills/memory in one place). **Separating `DATA_DIR` and `XANGI_PROCESS_NAME`** avoids collisions in both state files and PM2 operations.

### Startup warning

At startup, xangi acquires an exclusive `proper-lockfile` lock on `DATA_DIR`. If another xangi process is already holding the same `DATA_DIR`, a warning is printed:

```
[xangi] ⚠️  Another xangi process is using the same dataDir: /path/to/.xangi
[xangi] ⚠️  Sessions and settings will be overwritten unpredictably. Set DATA_DIR to a separate path for this instance.
```

When you see this message, stop one of the instances or separate `DATA_DIR` and restart.

The lock heartbeat updates the mtime every 30 seconds. Locks that haven't been updated for 60 seconds are treated as stale and the next startup forcibly takes them over, so locks left behind by crashes or SIGKILL are auto-reclaimed — no manual cleanup is required.

## Session Retention

By default, **all session history is kept** (each `sessions.json` entry is only a few hundred bytes, so long-term growth is negligible).

If you want to clean up old sessions, set `XANGI_SESSION_RETENTION_DAYS` to a number of days; sessions older than that (based on `updatedAt`) are pruned at startup.

```bash
XANGI_SESSION_RETENTION_DAYS=90    # prune sessions older than 90 days at startup
XANGI_SESSION_RETENTION_DAYS=0     # never prune (same as default)
```

Note: conversation transcripts (`logs/sessions/`) and tool trajectory logs (`logs/tool-trajectory/`, managed separately via `TOOL_TRAJECTORY_LOG_RETENTION_DAYS`) are not affected by this setting.

## Options

Settings you usually don't need to touch. Use them when you want stricter trust boundaries or tighter permission control.

### Dangerous Command Approval

Set `APPROVAL_ENABLED=true` to make the agent ask for confirmation via Discord/Slack buttons before running dangerous commands. **Disabled by default.**

```
⚠️ Dangerous command detected
git push origin main
Git push

[Allow] [Deny]
```

- Auto-denied after 2 minutes with no response
- Works with both Claude Code and Local LLM backends
- Managed by the approval server (`localhost:18181`, change with `APPROVAL_SERVER_PORT`)

**Detected patterns:**

| Category      | Pattern                                  | Description                |
| ------------- | ---------------------------------------- | -------------------------- |
| File deletion | `rm -r`, `rm -f`                         | Recursive/forced deletion  |
| Git           | `git push`                               | Push to remote             |
| Git           | `git reset --hard`                       | Discard changes            |
| Git           | `git clean -f`                           | Remove untracked files     |
| Git           | `git branch -D`                          | Force delete branch        |
| Permissions   | `chmod 777`                              | Grant full permissions     |
| Permissions   | `chown -R`                               | Recursive ownership change |
| System        | `shutdown`, `reboot`                     | System halt/restart        |
| System        | `kill -9`, `killall`                     | Force kill processes       |
| Remote exec   | `curl \| sh`, `wget \| bash`             | Remote script execution    |
| DB            | `DROP TABLE`, `TRUNCATE`                 | Database deletion          |
| Secrets       | `cat .env`, `cat *.pem`                  | Read credentials           |
| Secrets       | Write/Edit `.env`, `.pem`, `credentials` | Modify credentials         |

**Claude Code backend setup:**

Add a PreToolUse hook to `.claude/settings.json` in your workspace:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:18181/hooks/pre-tool-use",
            "timeout": 120
          }
        ]
      }
    ]
  }
}
```

**Local LLM backend:** No setup needed. Automatically queries the approval server.

### Per-message Permission Skip

xangi **skips permission confirmations by default** (`SKIP_PERMISSIONS=true`). Because Discord/Slack/Web chat invocations are non-interactive, there's no human to answer permission prompts; tasks would hang otherwise.

If you explicitly set `SKIP_PERMISSIONS=false` to re-enable permission prompts, you can still skip per-message via:

| Entry point       | Description                          |
| ----------------- | ------------------------------------ |
| `!skip <message>` | Run that single message in skip mode |
| `/skip <message>` | Slash command equivalent of `!skip`  |

```
@xangi !skip gh pr list
!skip build it                       # No mention needed in dedicated channels
/skip build it                       # Slash command version
```

> **⚠️ Security note:** In untrusted workspaces or multi-user environments, set `SKIP_PERMISSIONS=false` and combine with the [Dangerous Command Approval](#dangerous-command-approval) flow above.

## Troubleshooting

### "Prompt is too long" Error

**Symptom:** All messages in a specific channel return "Error occurred: Prompt is too long".

**Cause:** The session conversation history has exceeded the Claude Code (Agent SDK) context limit. Normally, the Agent SDK automatically compresses context, but if a session terminates abnormally, the state can become corrupted and unrecoverable.

**Solution:**

1. Run the `/new` command in the affected channel to reset the session
2. If that doesn't resolve it, restart xangi (`./bin/xangi service restart`)
