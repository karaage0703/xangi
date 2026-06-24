[日本語](README.md) | **English**

# xangi

> **A**GENTIC **N**EON **G**ENESIS **I**NTELLIGENCE

An AI assistant for Discord / Slack / browser / LINE, powered by Claude Code / Codex / Cursor CLI / Grok CLI / Antigravity CLI / Local LLM backends. Discord recommended; browser-only mode also supported.

## Features

- Discord / Slack / Web Chat UI / LINE support
- Claude Code / Codex / Cursor CLI / Grok CLI / Antigravity CLI / Local LLM support
- Per-channel backend / model / effort switching with `/backend`
- Skills, scheduler, and event triggers
- Docker, pm2, and auto-restart support
- Session persistence, timeout extension, and workspace hooks

## Architecture

```mermaid
flowchart LR
    User([User]) <-->|Message| Platform[Chat Platforms]
    Platform <-->|Prompt / Response| xangi[xangi]
    xangi <-->|Execute| Backend{{Agent Backends}}
    Backend <-->|Read / Write| WS[(Workspace)]
    Backend <--> External[External Knowledge / Web Services]
    Scheduler[[Scheduler / Event Trigger]] -->|Prompt| xangi

    classDef user fill:#fef3c7,stroke:#d97706,color:#111;
    classDef core fill:#dbeafe,stroke:#1e40af,color:#111;
    classDef ws fill:#fef9c3,stroke:#a16207,color:#111;
    classDef ext fill:#f3f4f6,stroke:#6b7280,color:#111;
    class User user;
    class Platform,xangi,Backend,Scheduler core;
    class WS ws;
    class External ext;
```

## Quick Start

### 1. Configure environment variables

```bash
cp .env.example .env
```

**Minimum required settings (.env):**
```bash
# Discord Bot Token (required)
DISCORD_TOKEN=your_discord_bot_token

# Allowed user ID (required, comma-separated for multiple, "*" for all)
DISCORD_ALLOWED_USER=123456789012345678
```

> 💡 The working directory defaults to `./workspace`. Set `WORKSPACE_PATH` to change it.

> 💡 See [Discord Setup](docs/en/discord-setup.md) for how to create a Bot and find IDs.

### 2. Build & Run

```bash
# Requires Node.js 22+ and at least one AI CLI
# Claude Code: curl -fsSL https://claude.ai/install.sh | bash
# Codex CLI:   npm install -g @openai/codex
# Cursor CLI:  curl https://cursor.com/install -fsS | bash
# Grok CLI:    curl -fsSL https://x.ai/cli/install.sh | bash
# Antigravity CLI: curl -fsSL https://antigravity.google/cli/install.sh | bash
# Local LLM:   Install Ollama (https://ollama.com)

npm install
npm run build
npm start

# Development
npm run dev
```

### 3. Verify

Mention the bot in Discord to start a conversation.

### Browser-only (no Discord/Slack)

If you don't want to set up tokens or just want to use it via a local browser, the Web Chat UI can run standalone.

Add to `.env`:

```bash
WEB_CHAT_ENABLED=true
```

```bash
npm start
```

Open `http://localhost:18888` in your browser.

> 💡 The Web Chat UI is opt-in (`WEB_CHAT_ENABLED=true`) to avoid surprise port conflicts. Change the port with `WEB_CHAT_PORT`.
> 💡 See [Slack Setup](docs/en/slack-setup.md) for Slack integration.

### Auto-restart (pm2)

xangi supports `/restart` command. A process manager is required for auto-recovery.

```bash
npm install -g pm2
pm2 start "npm start" --name xangi
pm2 restart xangi  # Manual restart
pm2 logs xangi     # View logs
```

## Usage

### Basics
- `@xangi your question` - Mention to interact
- No mention needed in dedicated channels

### Commands

| Command | Description |
|---------|-------------|
| `/new` | Start a new session |
| `/stop` | Stop running task |
| `/settings` | Show current settings |
| `/notify` | Configure completion notifications for this channel |
| `/backend` | Per-channel backend / model switching |
| `xangi-cmd schedule_*` | Scheduler (cron / reminders) |
| `xangi-cmd discord_*` | Discord operations (history / send / search, etc.) |
| `xangi-cmd trigger` | Event trigger (start an agent turn when a job finishes) |

Response messages include buttons (Stop / New Session). Set `DISCORD_SHOW_BUTTONS=false` to hide.

See [Usage Guide](docs/en/usage.md) for details.

## Running with Docker

Docker containers are available for isolated execution.

```bash
# Claude Code backend
docker compose up xangi -d --build

# Local LLM backend (Ollama)
docker compose up xangi-max -d --build

# GPU version (CUDA + Python + PyTorch)
docker compose up xangi-gpu -d --build
```

See [Usage Guide: Docker](docs/en/usage.md#docker-deployment) for details.

## Environment Variables

### Required (when using Discord)

| Variable | Description |
|----------|-------------|
| `DISCORD_TOKEN` | Discord Bot Token |
| `DISCORD_ALLOWED_USER` | Allowed user IDs (comma-separated, `*` for all) |

For browser-only operation, just set `WEB_CHAT_ENABLED=true` (no Discord token required).

See [Usage Guide](docs/en/usage.md#environment-variables-reference) for all environment variables.

## Workspace

Recommended workspace: [ai-assistant-workspace](https://github.com/karaage0703/ai-assistant-workspace)

A starter kit with pre-configured skills (note-taking, diary, transcription, Notion integration, etc.). Combine with xangi to automate daily tasks from chat.

## Related Projects

- [xangi-stackchan](https://github.com/karaage0703/xangi-stackchan) - A resident bridge that makes a Stack-chan (M5Stack) speak xangi's responses with facial expressions and head movement, by subscribing to the [external event stream](docs/en/events.md) (SSE)

## Book

📖 [生活に溶け込むAI — Build Your Own AI Assistant with AI Agents](https://karaage0703.booth.pm/items/8027277) (Japanese)

A book about building AI assistants with xangi.

## Documentation

- [Usage Guide](docs/en/usage.md) - Docker, env vars, Local LLM, troubleshooting
- [Discord Setup](docs/en/discord-setup.md) - Bot creation & ID lookup
- [Slack Setup](docs/en/slack-setup.md) - Slack integration
- [LINE Setup](docs/en/line-setup.md) - LINE Messaging API integration (incl. Tailscale Funnel for public webhook)
- [Design Document](docs/en/design.md) - Architecture, design philosophy, data flow
- [External Event Stream](docs/en/events.md) - Response lifecycle event delivery spec
- [Inter-instance Chat](docs/en/inter-instance-chat.md) - Message exchange & auto-talk between instances

## Acknowledgments

xangi's concept is inspired by [OpenClaw](https://github.com/openclaw/openclaw).

## License

MIT
