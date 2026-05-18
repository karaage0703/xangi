[日本語](../usage.md) | **English**

# Usage Guide

Detailed usage guide for xangi.

## Table of Contents

- [Basic Usage](#basic-usage)
- [Channel Topic Injection](#channel-topic-injection)
- [Timestamp Injection](#timestamp-injection)
- [Session Management](#session-management)
- [Scheduler](#scheduler)
- [Discord Operations (xangi-cmd)](#discord-operations-xangi-cmd)
- [Runtime Settings](#runtime-settings)
- [Autonomous AI Operations](#autonomous-ai-operations)
- [Standalone Mode](#standalone-mode)
- [Docker Deployment](#docker-deployment)
- [Local LLM](#local-llm)
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

### Discord Button Controls

Buttons are displayed on response messages.

- **During processing**: `Stop` / `延長` (Extend) / `⏱ MM:SS` buttons
  - `Stop` — equivalent to `/stop`. Interrupts the task
  - `延長` (Extend) — **doubles the remaining time** (adds residual to the deadline, capped at `TIMEOUT_MAX_MS`)
  - `⏱ MM:SS` — remaining time badge (click does nothing, turns red under 30s)
- **After completion**: `New` button — equivalent to `/new`. Resets the session

Set `DISCORD_SHOW_BUTTONS=false` to hide buttons.

### Dynamic Timeout Extension

Long-running tasks (code generation, deep research, etc.) can be extended via
the `延長` button before the initial timeout (`TIMEOUT_MS`, default 5 minutes)
fires. The button **doubles the remaining time** at the moment of the click.

- Initial timeout: `TIMEOUT_MS` (default 5 minutes)
- Extension behavior: adds the current remaining time to the deadline → remaining time becomes **2x**
  - e.g. 3 min remaining → click → 6 min remaining
  - e.g. 30 sec remaining → click → 1 min remaining (last-resort recovery)
- Absolute cap: `TIMEOUT_MAX_MS` (default 3600000ms = 1 hour)
  - Increase it (e.g. `TIMEOUT_MAX_MS=21600000` = 6h) for jobs that need to run for hours
- On/off: `TIMEOUT_EXTEND_ENABLED` (default `true`)
  - When `false`, the `延長` button is hidden and `extendTimeout` API returns `unsupported`
- UI:
  - Web Chat — `[延長][⏱ MM:SS]` shown next to the `⏹` button in the composer (only while sending)
  - Discord — `[Stop][延長][⏱ MM:SS]` row on the "Thinking…" message
  - Slack — same buttons in the Block Kit actions block
- Display turns red + pulses when under 30 seconds remain
- `延長` is disabled / hidden once the cap is reached

Supported backends: Claude Code (persistent-runner), Codex CLI, Gemini CLI,
Local LLM, Dynamic Runner (forwards to inner runner).

Programmatic API:

- `GET /api/sessions/:id/timeout` — current state `{active, timeoutAt, maxTimeoutAt, remainingMs, timeoutMs}`
- `POST /api/sessions/:id/timeout/extend` — `{additionalMs?: number}`, defaults to 5 minutes

> 💡 An optional approval flow can prompt for confirmation before dangerous commands run (disabled by default). See [Options > Dangerous Command Approval](#dangerous-command-approval).

## Scheduler

Set up periodic tasks and reminders. Ask the AI in natural language, and it calls `xangi-cmd schedule_add` etc. on your behalf.

### How to Operate

| Entry point | Description |
| --- | --- |
| `/schedule` (Discord slash) | Add / list / remove / toggle schedules via GUI |
| `xangi-cmd schedule_*` | Operate from AI or CLI (see below) |
| Natural language | Say e.g. "remind me at 9am every day" and the AI registers it |

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

## Discord Operations (xangi-cmd)

The AI performs Discord operations via the `xangi-cmd` CLI tool. Because it routes through xangi's built-in tool-server (HTTP API), secrets like `DISCORD_TOKEN` are never accessible to the AI CLI.

| Command | Description |
| --- | --- |
| `xangi-cmd discord_history --channel <ID> [--count N] [--offset M]` | Get channel history |
| `xangi-cmd web_history [--session <id>] [--count N]` | Web Chat current pane history (auto-resolves from `XANGI_CHANNEL_ID=web-chat:<id>`) |
| `xangi-cmd slack_history [--channel <id>] [--count N]` | Slack current channel history (auto-resolves from `XANGI_CHANNEL_ID=<channel>`) |
| `xangi-cmd discord_send --channel <ID> --message "text"` | Send a message |
| `xangi-cmd discord_channels --guild <ID>` | List channels |
| `xangi-cmd discord_search --channel <ID> --keyword "text"` | Search messages |
| `xangi-cmd discord_edit --channel <ID> --message-id <ID> --content "text"` | Edit a message |
| `xangi-cmd discord_delete --channel <ID> --message-id <ID>` | Delete a message |
| `xangi-cmd media_send --channel <ID> --file /path/to/file` | Send a file |

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
```

If `--channel` is omitted while running inside xangi, the current channel ID is used automatically. When running the CLI standalone, `--channel` is required.

```bash
# Edit and delete messages
xangi-cmd discord_edit --channel 1234567890 --message-id 111222333 --content "updated content"
xangi-cmd discord_delete --channel 1234567890 --message-id 111222333
```

### Tool Server

`xangi-cmd` relays requests to the tool-server (HTTP API) running inside the xangi process.

- Port is assigned automatically by the OS (no conflicts when running multiple instances)
- xangi injects `XANGI_TOOL_SERVER` into child processes at startup
- `xangi-cmd` uses `XANGI_TOOL_SERVER` to resolve the connection endpoint
- Runtime context such as the current channel ID is passed to the tool-server as `context`

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
| `/autoreply` | Toggle mention-free auto-reply for this channel (no restart needed) |
| `/respondtobots` | Toggle bot-to-bot reply ON/OFF (whitelist set via `RESPOND_TO_BOTS` env) |
| `/llmmode <agent\|lite\|chat\|default\|show>` | Switch this channel's Local LLM operation mode (persisted to `CHANNEL_OVERRIDES` in `.env`) |

### Backend Dynamic Switching

You can switch the backend, model, and effort level per channel.

| Command | Description |
| --- | --- |
| `/backend show` | Show the current backend and model |
| `/backend set claude-code` | Switch to Claude Code |
| `/backend set local-llm --model nemotron-3-nano` | Switch to Local LLM with a specific model |
| `/backend set claude-code --effort high` | Switch with a specific effort level |
| `/backend reset` | Reset to the default (.env settings) |
| `/backend list` | List available backends and models |

Switching always starts a new session (conversation history is not carried over).

#### Restricting via Environment Variables

```bash
# Allowed backends for switching (if unset, switching is disabled)
ALLOWED_BACKENDS=claude-code,local-llm

# Allowed models for switching (if unset, no restriction)
ALLOWED_MODELS=nemotron-3-nano,nemotron-3-super,qwen3.5:9b

# Per-channel backend overrides (JSON)
CHANNEL_OVERRIDES={"channelId":{"backend":"local-llm","model":"nemotron-3-nano"}}
```

#### Persistence

Settings changed with `/backend set` are automatically saved to `CHANNEL_OVERRIDES` in `.env` and persist across restarts.

In a Docker environment, `.env` lives outside the container and cannot be modified by the AI (Claude Code, etc.).

#### effort Option (Claude Code Only)

The Claude Code `--effort` option (`low` / `medium` / `high` / `max`) can be configured per channel. Because a process restart is required in persistent mode, the session resets on each switch. Use `/backend set claude-code --effort default` to clear the effort setting.

## Autonomous AI Operations

### Configuration Changes (Local Execution Only)

The AI can edit the `.env` file to change settings:

```
"Please respond in this channel too"
→ AI edits AUTO_REPLY_CHANNELS → restarts
```

You can also use the `/autoreply` command to toggle mention-free auto-reply per channel (no restart needed, persisted to `.env`).
To disable this command, set `ALLOW_AUTOREPLY_COMMAND=false` in `.env` (default: enabled).

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

Use case: run multiple xangi instances (e.g. xangi-borot=Claude / xangi-dev=Local LLM) in the same channel and compare their responses to the same prompt side-by-side.

#### Constraints / Known Limitations

- Responding to bot messages still requires the normal gate: **mention / DM / channel listed in `AUTO_REPLY_CHANNELS`**. Whitelisting a bot via `RESPOND_TO_BOTS` does not make it reply across all channels. To test bot-to-bot replies, add the test channel to `AUTO_REPLY_CHANNELS`.
- `xangi-cmd discord_send` always sends with `allowed_mentions: { parse: [] }` to suppress notifications. As a result, mentions (`<@user_id>` / `<@&role_id>` / `@everyone`) embedded in messages sent via `xangi-cmd` are *not* parsed into `message.mentions` on the receiving side (Discord-spec behaviour). Mention-based triggers from another bot using `xangi-cmd discord_send` will therefore not fire.
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

## Standalone Mode

If you have Docker, you can launch an AI assistant with a single command. No Discord or Slack token required. Runs with a local LLM (Ollama) and a web chat UI.

### Setup

```bash
git clone https://github.com/karaage0703/xangi.git
cd xangi
./quickstart.sh
```

Open your browser at `http://localhost:18888` to start chatting.

### How It Works

- **Ollama** — Local LLM server (downloads `gemma4:e4b` automatically on first launch)
- **xangi** — AI assistant (with web chat UI)
- **[ai-assistant-workspace](https://github.com/karaage0703/ai-assistant-workspace)** — Workspace (AGENTS.md, skills, memory)

### Changing the Model

```bash
LOCAL_LLM_MODEL=gemma4:26b ./quickstart.sh
```

### Stopping

```bash
docker compose -f docker-compose.standalone.yml down
```

### Workspace Persistence

The workspace is mounted to the host's `workspace/` directory. Data is preserved even when the container is stopped or removed. You can also edit files in `workspace/` directly or push them with git.

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

| Option | Recommended | Notes |
|--------|-------------|-------|
| `--max-model-len` | `131072` | Stable handling of long prompts such as full arxiv papers (~70k tokens) or site-patrol. 65536 isn't enough to fit a full paper |
| `--kv-cache-dtype` | `fp8` | Context-wide expansion enlarges the KV cache; fp8 compression absorbs this. Plenty of headroom on a GB10 80GiB-class GPU |
| `--gpu-memory-utilization` | `0.85` | 0.6 starves the KV cache; 0.85 is stable |
| `--max-num-batched-tokens` | Same as `--max-model-len` | Batching cap |
| `--enable-auto-tool-choice` `--tool-call-parser <model>` | Model-dependent | Enables tool calling. Gemma 4 uses the `gemma4` parser |
| `--speculative-config` (MTP) | Model-dependent | Specify when using an MTP drafter. Improves response latency |

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

| Variable | Description | Default |
|----------|-------------|---------|
| `LOCAL_LLM_TOOLS` | Tool execution (exec/read/write/edit/glob/grep/send_file/web_fetch) | `true` |
| `LOCAL_LLM_SKILLS` | Skill list injection | `true` |
| `LOCAL_LLM_XANGI_COMMANDS` | XANGI_COMMANDS injection | `true` |
| `LOCAL_LLM_TRIGGERS` | Triggers (!commands) | `false` |

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
description: "Get weather forecast (e.g., weather Tokyo)"
handler: handler.sh
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Tool name (used by LLM in function calling) |
| `description` | No | Tool description (included in the tool definition passed to LLM) |
| `handler` | Yes | Handler script filename |

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

**Allowed variables:** `PATH`, `HOME`, `USER`, `SHELL`, `LANG`, `LC_*`, `TERM`, `TMPDIR`, `TZ`, `NODE_ENV`, `NODE_PATH`, `WORKSPACE_PATH`, `AGENT_BACKEND`, `AGENT_MODEL`, `SKIP_PERMISSIONS`, `DATA_DIR`, `XANGI_TOOL_SERVER`, `XANGI_CHANNEL_ID`

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
| `DISCORD_SHOW_BUTTONS` | Show Stop/New Session buttons | `true` |
| `ALLOW_AUTOREPLY_COMMAND` | Enable `/autoreply` command | `true` |
| `RESPOND_TO_BOTS` | Whitelist of bot IDs to respond to (`*` for all bots) | - |
| `RESPOND_TO_BOTS_ENABLED` | Toggle bot-to-bot reply ON/OFF (`/respondtobots` switches at runtime) | `false` |
| `RESPOND_TO_BOTS_MAX_CONSECUTIVE` | Max consecutive replies to the same bot (0 = unlimited) | `3` |
| `ALLOW_RESPOND_TO_BOTS_COMMAND` | Enable `/respondtobots` command | `true` |
| `ALLOW_LLM_MODE_COMMAND` | Enable `/llmmode` command (Local LLM mode switcher) | `true` |
| `INJECT_CHANNEL_TOPIC` | Inject channel topic into prompt | `true` |
| `INJECT_TIMESTAMP` | Inject current time into prompt | `true` |

### AI Agent

| Variable | Description | Default |
|----------|-------------|---------|
| `AGENT_BACKEND` | Backend (`claude-code` / `codex` / `gemini` / `local-llm`) | `claude-code` |
| `AGENT_MODEL` | Model to use | - |
| `WORKSPACE_PATH` | Working directory (local execution) | `./workspace` |
| `XANGI_WORKSPACE` | Host-side workspace path (Docker execution) | `./workspace` |
| `SKIP_PERMISSIONS` | Skip permissions by default (avoids deadlocks for non-interactive chat platforms) | `true` |
| `TIMEOUT_MS` | Initial request timeout (milliseconds) | `300000` |
| `TIMEOUT_MAX_MS` | Absolute upper limit for timeout extension (milliseconds) | `3600000` |
| `TIMEOUT_EXTEND_ENABLED` | Enable / disable the `延長` button | `true` |
| `ALLOWED_BACKENDS` | Allowed backends for `/backend` switching (comma-separated) | - |
| `ALLOWED_MODELS` | Allowed models for `/backend` switching (comma-separated) | - |
| `CHANNEL_OVERRIDES` | Per-channel backend settings (JSON) | - |
| `PERSISTENT_MODE` | Persistent process mode | `true` |
| `MAX_PROCESSES` | Maximum concurrent processes | `10` |
| `IDLE_TIMEOUT_MS` | Auto-terminate idle processes after | `1800000` |
| `DATA_DIR` | Data storage directory (schedules, sessions, etc.) | `WORKSPACE_PATH/.xangi` |
| `GH_TOKEN` | GitHub CLI token | - |

### Tool Approval

| Variable | Description | Default |
|----------|-------------|---------|
| `APPROVAL_ENABLED` | Require Discord/Slack approval before dangerous commands | `false` |
| `APPROVAL_SERVER_PORT` | Approval server listen port | `18181` |

### Web Chat UI

| Variable | Description | Default |
|----------|-------------|---------|
| `WEB_CHAT_ENABLED` | Enable Web Chat UI. `true` exposes `http://localhost:<WEB_CHAT_PORT>` | `false` |
| `WEB_CHAT_PORT` | Web Chat UI port | `18888` |
| `WEB_CHAT_UPLOAD_ACCEPT` | Upload allowlist (HTML `accept` syntax). Empty = allow all. `.ext` entries are also enforced server-side | (unset / allow all) |
| `WEB_CHAT_DOWNLOAD_ACCEPT` | Download allowlist of extensions (e.g. `.html,.txt,.md`). Empty = allow all. Known extensions are served inline with proper Content-Type; unknown ones fall back to `Content-Disposition: attachment` | (unset / allow all) |

### Scheduler

| Variable | Description | Default |
|----------|-------------|---------|
| `SCHEDULER_ENABLED` | Enable scheduler | `true` |
| `STARTUP_ENABLED` | Enable startup tasks | `true` |

### GitHub App Authentication (Optional)

When GitHub App settings are configured, installation tokens are auto-generated on each `gh` CLI execution. No PAT or `gh auth login` needed.

| Variable | Description |
|----------|-------------|
| `GITHUB_APP_ID` | GitHub App ID |
| `GITHUB_APP_INSTALLATION_ID` | Installation ID |
| `GITHUB_APP_PRIVATE_KEY_PATH` | Private key file path |

Without these settings, existing `gh` authentication (`gh auth login` / `GH_TOKEN`) is used as-is.

**Docker:** The private key is auto-mounted to `/secrets/github-app.pem`. Set the host-side path in `.env`.

**Security:**
- The private key is loaded into memory at startup and is not directly accessible as a file by the AI agent
- Token generation is performed via the tool-server's HTTP endpoint (`/github-token`), and the AI agent can only obtain short-lived installation tokens (valid for 1 hour)
- If token generation fails, it does NOT fall back to PAT — it errors out

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
| `LOCAL_LLM_MAX_TOKENS` | Maximum tokens (per-request `max_tokens`) | `8192` |
| `LOCAL_LLM_NUM_CTX` | Context window size (Ollama; also used as the basis for context budget calculation) | Model default |
| `LOCAL_LLM_TEMPERATURE` | Sampling temperature (0 for deterministic; useful to suppress agent-mode format drift) | Model default |
| `LOCAL_LLM_CONTEXT_MAX_CHARS` | Maximum history characters (explicit; auto-derived from `LOCAL_LLM_NUM_CTX` if unset) | Auto-derived |
| `LOCAL_LLM_SYSTEM_PROMPT_BUDGET_TOKENS` | Tokens reserved for the system prompt (used in derivation) | `8000` |
| `LOCAL_LLM_OUTPUT_BUDGET_TOKENS` | Tokens reserved for one response (used in derivation) | `4096` |
| `LOCAL_LLM_SAFETY_MARGIN_TOKENS` | Safety margin tokens (used in derivation) | `1000` |
| `LOCAL_LLM_CONTEXT_KEEP_LAST` | Most recent N messages are never trimmed | `10` |
| `LOCAL_LLM_TOOL_RESULT_MAX_CHARS` | Max chars for in-context tool results (head/tail trim) | `4000` |
| `LOCAL_LLM_MAX_SESSION_MESSAGES` | Maximum number of messages kept per session | `50` |
| `LOCAL_LLM_TOOL_SEARCH_ENABLED` | Enable tool deferred loading (`tool_search`) | `true` |
| `LOCAL_LLM_TOOL_SEARCH_LIMIT` | Max tools returned per `tool_search` call | `8` |
| `LOCAL_LLM_ALWAYS_LOADED_TOOLS` | Always-loaded tool names (comma-separated). Tools not listed are deferred | `read,write,edit,exec,glob,grep,send_file,web_fetch,tool_search` |
| `EXEC_TIMEOUT_MS` | Exec tool timeout (milliseconds) | `120000` |
| `WEB_FETCH_TIMEOUT_MS` | web_fetch tool timeout (milliseconds) | `15000` |
| `LOCAL_LLM_READ_MAX_BYTES` | read tool file size limit (bytes) | `524288` (512KB) |
| `LOCAL_LLM_READ_JSON_MAX_BYTES` | read tool JSON file size limit (bytes) | `5120` (5KB) |
| `LOCAL_LLM_WRITE_MAX_BYTES` | write tool content size limit (bytes) | `524288` (512KB) |

### Slack

| Variable | Description |
|----------|-------------|
| `SLACK_BOT_TOKEN` | Slack Bot Token (xoxb-...) |
| `SLACK_APP_TOKEN` | Slack App Token (xapp-...) |
| `SLACK_ALLOWED_USER` | Allowed user ID |
| `SLACK_AUTO_REPLY_CHANNELS` | Channel IDs to respond without mention |
| `SLACK_REPLY_IN_THREAD` | Reply in threads (default: `true`) |

## Running Multiple Instances

If you run multiple xangi instances on the same machine (e.g. one for production and one for development), **always give each instance its own `DATA_DIR`**. The default is `${WORKSPACE_PATH}/.xangi/`; sharing this between instances causes `sessions.json` to be overwritten back and forth, which can silently wipe out newly created sessions (because a long-running process keeps the stale in-memory list and writes it back).

### Recommended layout

```bash
# Production (borot)
WORKSPACE_PATH=/home/user/borot
# DATA_DIR omitted → /home/user/borot/.xangi/

# Development (xangi-dev)
WORKSPACE_PATH=/home/user/borot
DATA_DIR=/home/user/xangi-dev/.xangi   # ← isolated explicitly
```

Sharing `WORKSPACE_PATH` itself is fine (you may want skills/memory in one place). **Separating only `DATA_DIR`** is enough to avoid collisions.

### Startup warning

At startup, xangi acquires an exclusive `proper-lockfile` lock on `DATA_DIR`. If another xangi process is already holding the same `DATA_DIR`, a warning is printed:

```
[xangi] ⚠️  Another xangi process is using the same dataDir: /path/to/.xangi
[xangi] ⚠️  Sessions and settings will be overwritten unpredictably. Set DATA_DIR to a separate path for this instance.
```

When you see this message, stop one of the instances or separate `DATA_DIR` and restart.

The lock heartbeat updates the mtime every 30 seconds. Locks that haven't been updated for 60 seconds are treated as stale and the next startup forcibly takes them over, so locks left behind by crashes or SIGKILL are auto-reclaimed — no manual cleanup is required.

## Session Retention

To prevent `sessions.json` from growing unbounded, **stale sessions are automatically pruned at startup**.

- Default retention: **90 days** (based on `updatedAt`)
- Configurable via the `XANGI_SESSION_RETENTION_DAYS` environment variable
- Set to `0` to disable pruning

```bash
XANGI_SESSION_RETENTION_DAYS=180   # keep half a year
XANGI_SESSION_RETENTION_DAYS=0     # never prune
```

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

### Per-message Permission Skip

xangi **skips permission confirmations by default** (`SKIP_PERMISSIONS=true`). Because Discord/Slack/Web chat invocations are non-interactive, there's no human to answer permission prompts; tasks would hang otherwise.

If you explicitly set `SKIP_PERMISSIONS=false` to re-enable permission prompts, you can still skip per-message via:

| Entry point | Description |
| --- | --- |
| `!skip <message>` | Run that single message in skip mode |
| `/skip <message>` | Slash command equivalent of `!skip` |

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
2. If that doesn't resolve it, restart xangi (`pm2 restart xangi`)
