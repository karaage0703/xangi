[日本語](../usage.md) | **English**

# Usage Guide

Detailed usage guide for xangi.

## Table of Contents

- [Basic Usage](#basic-usage)
- [Channel Topic Injection](#channel-topic-injection)
- [Timestamp Injection](#timestamp-injection)
- [Session Management](#session-management)
- [Scheduler](#scheduler)
- [Discord Commands](#discord-commands)
- [Command Prefix](#command-prefix)
- [Runtime Settings](#runtime-settings)
- [Autonomous AI Operations](#autonomous-ai-operations)
- [Docker Deployment](#docker-deployment)
- [Local LLM (Ollama)](#local-llm-ollama)
- [Troubleshooting](#troubleshooting)

## Basic Usage

### Mention to Invoke

```
@xangi your question here
```

### Dedicated Channels

Channels configured in `AUTO_REPLY_CHANNELS` will respond without requiring a mention.

## Channel Topic Injection

When a Discord channel has a topic (description) set, its content is automatically injected into the prompt.

This allows you to provide different context or instructions to the AI for each channel.

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

| Command | Description |
| --- | --- |
| `/new`, `!new`, `new` | Start a new session |
| `/clear`, `!clear`, `clear` | Clear session history |

### Discord Button Controls

Buttons are displayed on response messages.

- **During processing**: `Stop` button — equivalent to `/stop`. Interrupts the task
- **After completion**: `New` button — equivalent to `/new`. Resets the session

Set `DISCORD_SHOW_BUTTONS=false` to hide buttons.

### Dangerous Command Approval

When the agent attempts to execute a dangerous command, a confirmation message with buttons appears in Discord.

- Auto-denied after 2 minutes with no response
- Works with both Claude Code and Local LLM backends
- Managed by approval server (`localhost:18181`)

**Detected patterns:**

| Category | Pattern | Description |
|----------|---------|-------------|
| File deletion | `rm -r`, `rm -f` | Recursive/forced deletion |
| Git | `git push` | Push to remote |
| Git | `git reset --hard` | Discard changes |
| Git | `git clean -f` | Remove untracked files |
| Git | `git branch -D` | Force delete branch |
| Permissions | `chmod 777` | Grant full permissions |
| Permissions | `chown -R` | Recursive ownership change |
| System | `shutdown`, `reboot` | System halt/restart |
| System | `kill -9`, `killall` | Force kill processes |
| Remote exec | `curl \| sh`, `wget \| bash` | Remote script execution |
| DB | `DROP TABLE`, `TRUNCATE` | Database deletion |
| Secrets | `cat .env`, `cat *.pem` | Read credentials |
| Secrets | Write/Edit `.env`, `.pem`, `credentials` | Modify credentials |

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

## Scheduler

Set up periodic tasks and reminders. The AI interprets natural language and automatically executes `!schedule` commands.

### Command List

| Command | Description |
| --- | --- |
| `/schedule` | Schedule operations via slash command |
| `!schedule <time> <message>` | Add a schedule |
| `!schedule list` / `!schedule` | Show all schedules (all channels) |
| `!schedule remove <number>` | Remove (multiple OK: `remove 1 2 3`) |
| `!schedule toggle <number>` | Enable/disable toggle |

> The `/schedule` slash command provides the same functionality.

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

| Field | Value | Description |
| --- | --- | --- |
| Minute | 0-59 | |
| Hour | 0-23 | |
| Day | 1-31 | |
| Month | 1-12 | |
| Day of Week | 0-6 | 0=Sunday, 1=Monday, ... |

### CLI (Command Line)

```bash
# Add a schedule
npx tsx src/schedule-cli.ts add --channel <channelId> "Every day 9:00 good morning"

# List schedules
npx tsx src/schedule-cli.ts list

# Remove by number
npx tsx src/schedule-cli.ts remove --channel <channelId> 1

# Remove multiple
npx tsx src/schedule-cli.ts remove --channel <channelId> 1 2 3

# Enable/disable toggle
npx tsx src/schedule-cli.ts toggle --channel <channelId> 1
```

### Data Storage

Schedule data is saved in `${DATA_DIR}/schedules.json`.

- Default: `/workspace/.xangi/schedules.json`
- Configurable via the `DATA_DIR` environment variable

## Discord Commands

Commands for the AI to perform Discord operations.

| Command | Description |
| --- | --- |
| `!discord send <#channel> message` | Send a message to a specified channel |
| `!discord channels` | List server channels |
| `!discord history [count] [<#channel>]` | Get latest messages from a channel (default 10, max 100) |
| `!discord search keyword` | Search messages in the current channel |
| `!discord delete <messageID>` | Delete a specified message |
| `!discord delete <message link>` | Delete a message by link (works across channels) |
| `!discord edit <ID/link/last> content` | Edit own message (`last` for the most recent message) |

### Examples

```
# Post to another channel
!discord send <#1234567890> Work completed!

# Check channel list
!discord channels

# Get channel history (results return to the AI's context)
!discord history              # Latest 10 from current channel
!discord history 50           # Latest 50 from current channel
!discord history 20 <#1234>   # 20 from a specified channel
!discord history 30 offset:30 # Get messages 30-60 (scrolling back)

# Search messages
!discord search PR

# Delete by message ID
!discord delete 123456789012345678

# Delete by message link (works for messages in other channels too)
!discord delete https://discord.com/channels/111/222/333

# Edit the most recent own message
!discord edit last corrected content

# Edit by message ID
!discord edit 123456789012345678 new content
```

## Skipping Permission Confirmations

By default, the AI asks for permission when creating files or executing commands.
Use the `!skip` prefix or `/skip` slash command to skip permission confirmations.

Setting the environment variable `SKIP_PERMISSIONS=true` makes all messages run in skip mode by default.

### `!skip` Prefix

Adding `!skip` at the beginning of a message runs only that message in skip mode.

### `/skip` Slash Command

`/skip message` executes the message with permission confirmations skipped. Same behavior as the `!skip` prefix.

### Examples

```
@xangi !skip gh pr list
!skip build it                       # No mention needed in dedicated channels
/skip build it                       # Slash command version
```

## Runtime Settings

Runtime settings are saved in `${WORKSPACE_PATH}/settings.json`.

```json
{
  "autoRestart": true
}
```

| Setting | Description | Default |
| --- | --- | --- |
| `autoRestart` | Allow AI agent to trigger restarts | `true` |

### Viewing and Changing Settings

| Command | Description |
| --- | --- |
| `/settings` | Show current settings |
| `/restart` | Restart the bot |

## Autonomous AI Operations

### Configuration Changes (Local Execution Only)

The AI can edit the `.env` file to change settings:

```
"Please respond in this channel too"
→ AI edits AUTO_REPLY_CHANNELS → restarts
```

### System Commands

Special commands output by the AI:

| Command | Description |
| --- | --- |
| `SYSTEM_COMMAND:restart` | Restart the bot |

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

- **Docker**: Automatically recovers with `restart: always`
- **Local**: Requires a process manager like pm2

```bash
# Example with pm2
pm2 start "npm start" --name xangi
pm2 logs xangi
```

### Changing Environment Variables with pm2

xangi loads environment variables via `node --env-file=.env`. To change environment variables, **edit the `.env` file and then run `pm2 restart`**.

```bash
# Correct method: edit .env then restart
vim .env  # Add TIMEOUT_MS=60000
pm2 restart xangi
```

> **Warning: Do not use `pm2 restart --update-env`!**
> `--update-env` saves all shell environment variables to pm2. If you're running multiple xangi instances, another instance's `DISCORD_TOKEN` etc. may leak in, causing dual login with the same bot token.
> `node --env-file=.env` does not overwrite existing environment variables, so values set by pm2 take precedence.

## Docker Deployment

Run in a container-isolated environment. Three containers are available:

| Container | Dockerfile | Purpose |
|---|---|---|
| `xangi` | `Dockerfile` | Lightweight (Claude Code / Codex / Gemini CLI) |
| `xangi-max` | `Dockerfile.max` | Full version (uv + Python support, for Local LLM) |
| `xangi-gpu` | `Dockerfile.gpu` | GPU version (CUDA + PyTorch, for image generation / audio processing) |

### Claude Code Backend

```bash
docker compose up xangi -d --build

# Claude Code authentication
docker exec -it xangi claude
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
docker exec -it xangi-gpu claude

# Verify GPU
docker exec -it xangi-gpu python3 -c "import torch; print(torch.cuda.is_available())"
```

> **Tip**: `xangi-gpu` is a superset of `xangi-max`. Use this when you need skills that require GPU/PyTorch (speech transcription, image generation, etc.).

### Docker Operations

```bash
# Stop
docker compose down

# Restart (e.g. after .env changes)
docker compose up xangi-max -d --force-recreate

# Check logs
docker logs -f xangi-max
```

### Workspace Mounting

| Environment | Variable | Description |
|---|---|---|
| Local | `WORKSPACE_PATH` | Path used directly by the agent |
| Docker | `XANGI_WORKSPACE` | Host-side path (mapped to `/workspace` inside the container) |

For Docker deployment, set `XANGI_WORKSPACE` in `.env`:

```bash
XANGI_WORKSPACE=/home/user/my-workspace
```

> **Warning: Do not use `WORKSPACE_PATH`.** It may conflict with host shell environment variables.

### Security

- Containers do **not have direct access** to the host network
- The Ollama container is isolated within the same docker network
- Environment variables passed to the AI agent are restricted via a whitelist (e.g. `DISCORD_TOKEN` is not accessible)

## Local LLM (Ollama)

xangi's Local LLM backend uses the OpenAI-compatible API (`/v1/chat/completions`).

### Local Execution (Ollama)

```bash
# Configure .env
AGENT_BACKEND=local-llm
LOCAL_LLM_MODEL=gpt-oss:20b
# LOCAL_LLM_BASE_URL=http://localhost:11434  # default
```

Works as-is if Ollama is running.

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

| Variable | Description | Default |
|----------|-------------|---------|
| `LOCAL_LLM_TOOLS` | Tool execution (exec/read/web_fetch) | `true` |
| `LOCAL_LLM_SKILLS` | Skill list injection | `true` |
| `LOCAL_LLM_XANGI_COMMANDS` | XANGI_COMMANDS injection | `true` |
| `LOCAL_LLM_TRIGGERS` | Triggers (!commands) | `false` |

`LOCAL_LLM_MODE` presets are also available (individual settings take priority):
- `agent` (default) — all on
- `chat` — all off
- `lite` — triggers=true, rest off

Workspace context (AGENTS.md, etc.) is always injected regardless of settings.

### Triggers

LLMs can invoke functionality by outputting magic words (`!command`) in their response text. Enable with `LOCAL_LLM_TRIGGERS=true`.

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
trigger: "!weather"
description: "Check the weather"
handler: handler.sh
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Trigger name |
| `trigger` | Yes | Magic word (starts with `!`) |
| `description` | No | Description (shown in system prompt) |
| `handler` | Yes | Handler script filename |

#### Handler Specification

- Executed as `bash handler.sh [args...]` with workspace root as `cwd`
- Arguments are passed as space-separated command line args (e.g., `!weather Tokyo` → `bash handler.sh Tokyo`)
- Timeout: `EXEC_TIMEOUT_MS` (default 120 seconds)
- `stdout` content is sent to Discord

#### How It Works

1. On startup, xangi scans the workspace `triggers/` directory
2. Available triggers are added to the system prompt
3. When the LLM response contains a trigger word, the handler is executed
4. Handler output is sent to Discord

#### Notes

- **Chat mode only**. Triggers are ignored in agent mode
- Triggers scan the entire LLM response text line by line
- If multiple triggers match in one response, only the first match is executed

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

| Error | Message |
|-------|---------|
| ECONNREFUSED / fetch failed | Could not connect to the LLM server. Please verify the server is running. |
| timeout / aborted | LLM response timed out. Please try again later. |
| 401 / 403 | Authentication to the LLM server failed. Please check your API key. |
| 429 | LLM server rate limit reached. Please try again later. |
| 500 / 502 / 503 | An internal error occurred on the LLM server. Please try again later. |
| Other | LLM error: (original error message) |

### Example Models

| Model | Size | Features | Notes |
|-------|------|----------|-------|
| `gpt-oss:20b` | 13GB | MoE, high quality, tool call support | Recommended |
| `gpt-oss:120b` | 65GB | MoE (active 12B), highest quality | Requires large memory |
| `nemotron-3-nano` | 24GB | Mamba hybrid, fast | |
| `nemotron-3-super` | 86GB | Mamba hybrid, high accuracy | Requires large memory |
| `qwen3.5:9b` | 6.6GB | Lightweight, Thinking support | |
| `Qwen3.5-27B-FP8` | 29GB | High-precision tool calls, ~6 tok/s | vLLM recommended |

Other models available via Ollama/vLLM are also supported.

## Security

### Environment Variable Whitelist

Environment variables passed to the AI agent (CLI spawn / Local LLM exec) are managed in `src/safe-env.ts`. Only variables listed in the whitelist are passed; secrets like `DISCORD_TOKEN` are not accessible to the AI.

**Allowed variables:** `PATH`, `HOME`, `USER`, `SHELL`, `LANG`, `LC_*`, `TERM`, `TMPDIR`, `TZ`, `NODE_ENV`, `NODE_PATH`, `WORKSPACE_PATH`, `AGENT_BACKEND`, `AGENT_MODEL`, `SKIP_PERMISSIONS`, `DATA_DIR`

**Not passed (examples):** `DISCORD_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `LOCAL_LLM_API_KEY`, `GH_TOKEN`

To modify the whitelist, edit `ALLOWED_ENV_KEYS` in `src/safe-env.ts`.

## Environment Variables Reference

### Discord

| Variable | Description | Default |
|----------|-------------|---------|
| `DISCORD_TOKEN` | Discord Bot Token | **Required** |
| `DISCORD_ALLOWED_USER` | Allowed user ID (comma-separated for multiple, `*` to allow all) | **Required** |
| `AUTO_REPLY_CHANNELS` | Channel IDs to respond without mention (comma-separated) | - |
| `DISCORD_STREAMING` | Streaming output | `true` |
| `DISCORD_SHOW_THINKING` | Show thinking process | `true` |
| `INJECT_CHANNEL_TOPIC` | Inject channel topic into prompt | `true` |
| `INJECT_TIMESTAMP` | Inject current time into prompt | `true` |

### AI Agent

| Variable | Description | Default |
|----------|-------------|---------|
| `AGENT_BACKEND` | Backend (`claude-code` / `codex` / `gemini` / `local-llm`) | `claude-code` |
| `AGENT_MODEL` | Model to use | - |
| `WORKSPACE_PATH` | Working directory (local execution) | `./workspace` |
| `XANGI_WORKSPACE` | Host-side workspace path (Docker execution) | `./workspace` |
| `SKIP_PERMISSIONS` | Skip permissions by default | `false` |
| `TIMEOUT_MS` | Timeout (milliseconds) | `300000` |
| `PERSISTENT_MODE` | Persistent process mode | `true` |
| `MAX_PROCESSES` | Maximum concurrent processes | `10` |
| `IDLE_TIMEOUT_MS` | Auto-terminate idle processes after | `1800000` |
| `DATA_DIR` | Data storage directory | `.xangi` |
| `GH_TOKEN` | GitHub CLI token | - |

### GitHub App Authentication (Optional)

When GitHub App settings are configured, installation tokens are auto-generated on each `gh` CLI execution. No PAT or `gh auth login` needed.

| Variable | Description |
|----------|-------------|
| `GITHUB_APP_ID` | GitHub App ID |
| `GITHUB_APP_INSTALLATION_ID` | Installation ID |
| `GITHUB_APP_PRIVATE_KEY_PATH` | Private key file path |

Without these settings, existing `gh` authentication (`gh auth login` / `GH_TOKEN`) is used as-is.

**Docker:** The private key is auto-mounted to `/secrets/github-app.pem`. Set the host-side path in `.env`.

**Security:** If token generation fails, it does NOT fall back to PAT — it errors out. A `🔑App` badge appears in tool display when `gh` runs.

### Local LLM (when `AGENT_BACKEND=local-llm`)

| Variable | Description | Default |
|----------|-------------|---------|
| `LOCAL_LLM_BASE_URL` | LLM server URL | `http://localhost:11434` |
| `LOCAL_LLM_MODE` | Preset (`agent` / `chat` / `lite`) | `agent` |
| `LOCAL_LLM_TOOLS` | Tool execution | `true` |
| `LOCAL_LLM_SKILLS` | Skill list injection | `true` |
| `LOCAL_LLM_XANGI_COMMANDS` | XANGI_COMMANDS injection | `true` |
| `LOCAL_LLM_TRIGGERS` | Triggers (!commands) | `false` |
| `LOCAL_LLM_MODEL` | Model name | - |
| `LOCAL_LLM_API_KEY` | API key (if required by vLLM, etc.) | - |
| `LOCAL_LLM_THINKING` | Enable thinking model reasoning | `true` |
| `LOCAL_LLM_MAX_TOKENS` | Maximum tokens | `8192` |
| `LOCAL_LLM_NUM_CTX` | Context window size (for Ollama) | Model default |
| `EXEC_TIMEOUT_MS` | Exec tool timeout (milliseconds) | `120000` |
| `WEB_FETCH_TIMEOUT_MS` | web_fetch tool timeout (milliseconds) | `15000` |

### Slack

| Variable | Description |
|----------|-------------|
| `SLACK_BOT_TOKEN` | Slack Bot Token (xoxb-...) |
| `SLACK_APP_TOKEN` | Slack App Token (xapp-...) |
| `SLACK_ALLOWED_USER` | Allowed user ID |
| `SLACK_AUTO_REPLY_CHANNELS` | Channel IDs to respond without mention |
| `SLACK_REPLY_IN_THREAD` | Reply in threads (default: `true`) |

## Troubleshooting

### "Prompt is too long" Error

**Symptom:** All messages in a specific channel return "Error occurred: Prompt is too long".

**Cause:** The session conversation history has exceeded the Claude Code (Agent SDK) context limit. Normally, the Agent SDK automatically compresses context, but if a session terminates abnormally, the state can become corrupted and unrecoverable.

**Solution:**

1. Run the `/new` command in the affected channel to reset the session
2. If that doesn't resolve it, restart xangi (`pm2 restart xangi`)
