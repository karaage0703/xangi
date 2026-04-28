[日本語](../design.md) | **English**

# Design Document

This document explains the architecture and design philosophy of xangi.

## Overview

xangi is "a wrapper that makes AI CLIs (Claude Code / Codex CLI / Gemini CLI) and local LLMs (Ollama, etc.) accessible from chat platforms."

```
User → Chat (Discord/Slack) → xangi → AI CLI → Workspace
```

## Architecture

```mermaid
graph LR
    User --> |Message| Chat[Chat Platform<br/>Discord / Slack]
    Chat --> |Prompt| xangi
    xangi --> |Execute| CLI[AI Backend<br/>Claude Code / Codex<br/>Gemini CLI / Local LLM]
    CLI --> |File Operations| WS[Workspace<br/>skills / AGENTS.md]
    xangi --> |Periodic Execution| Scheduler
    Scheduler --> |Prompt| CLI
```

### Layer Structure

| Layer | Role | Implementation |
|-------|------|----------------|
| Chat | User interface | Discord.js, Slack Bolt |
| xangi | AI CLI integration & control | index.ts, agent-runner.ts, dynamic-runner.ts |
| Backend Resolution | Per-channel backend resolution | backend-resolver.ts, settings.ts |
| AI CLI | Actual AI processing | Claude Code, Codex CLI, Gemini CLI, Local LLM |
| Workspace | Files & skills | skills/, AGENTS.md |

## Components

### Entry Point (index.ts)

The main orchestrator. Integrates the following:

- Discord/Slack client initialization
- Message reception and routing
- AI CLI invocation
- Scheduler management
- Command handling (via `xangi-cmd` CLI tool + text parsing)

### Agent Runner (agent-runner.ts)

An interface that abstracts AI CLIs:

```typescript
interface AgentRunner {
  run(prompt: string, options?: RunOptions): Promise<RunResult>;
  runStream(prompt: string, callbacks: StreamCallbacks, options?: RunOptions): Promise<RunResult>;
}
```

### Dynamic Runner Manager (dynamic-runner.ts)

A wrapper that dynamically switches backend, model, and effort per channel:

```
Message received
  → BackendResolver.resolve(channelId)
  → Retrieve { backend, model, effort }
  → DynamicRunnerManager routes to the appropriate runner
  → Execute
```

BackendResolver priority:
1. channelOverrides set via `/backend set` (in-memory, persisted to CHANNEL_OVERRIDES in `.env`)
2. Defaults from `.env` (`AGENT_BACKEND`, `AGENT_MODEL`)

### System Prompt (base-runner.ts)

Manages the system prompts that xangi injects into AI CLIs:

- **Chat platform info** — A short fixed text indicating the conversation is via Discord/Slack
- **XANGI_COMMANDS** — Injects platform-specific command specifications from `src/prompts/`
  - Common commands (`xangi-commands-common.ts`): Timeout handling, etc.
  - Chat platform common (`xangi-commands-chat-platform.ts`): File sending (MEDIA:), message separators (===), scheduling, system commands
  - Discord-specific (`xangi-commands-discord.ts`): `xangi-cmd discord_*` CLI tools, auto-expand
  - Slack-specific (`xangi-commands-slack.ts`): Slack-specific operations
  - Automatic platform detection: If only Discord is active, only Discord-specific commands are injected (saves tokens)
- **Platform identification** — Each message is annotated with `[Platform: Discord]` or `[Platform: Slack]`. The AI uses the appropriate commands accordingly

AGENTS.md / CHARACTER.md / USER.md and other workspace settings are delegated to each AI CLI's auto-loading feature:

| CLI | Auto-loaded Files | Injection Method |
|-----|-------------------|------------------|
| Claude Code | `CLAUDE.md` | `--append-system-prompt` (one-time) |
| Codex CLI | `AGENTS.md` | Embedded via `<system-context>` tag |
| Gemini CLI | `GEMINI.md` | Auto-loaded by CLI (no xangi-side injection) |
| Local LLM | `AGENTS.md`, `MEMORY.md` | Directly embedded in system prompt (`CLAUDE.md` is typically a symlink to `AGENTS.md`, so it's excluded) |

### AI CLI Adapters

| File | Supported CLI | Features |
|------|---------------|----------|
| claude-code.ts | Claude Code | Streaming support, session management |
| persistent-runner.ts | Claude Code (persistent) | Persistent process via `--input-format=stream-json`, queue management, circuit breaker |
| codex-cli.ts | Codex CLI | Made by OpenAI, 0.98.0 compatible, cancel support |
| gemini-cli.ts | Gemini CLI | Made by Google, session management, streaming support |
| local-llm/runner.ts | Local LLM | Direct calls to local LLMs like Ollama, tool execution & streaming support |

#### Local LLM Adapter Detailed Design

**Session Retry Flow:**

```
1. Add user message to session history
   ↓
2. Send request to LLM API
   ↓
3a. Success → Return tool loop or final response
3b. Error occurred
   ↓
4. Evaluate error with isSessionRelatedError()
   - context length exceeded / too many tokens / max_tokens / context window
   - invalid message / malformed / 400 / 422
   ↓
5a. Session-related error → Clear session (keep only last user message) → Retry
5b. Not session-related → Generate user-facing message with formatLlmError() and return
   ↓
6. Retry also failed → Return error message via formatLlmError()
```

**Tool Calling Flow (llm-client.ts):**

The LLM client has two API paths: Ollama native API and OpenAI-compatible API. Note the different message formats for tool calling:

| Item | OpenAI-compatible API | Ollama Native API |
|------|----------------------|-------------------|
| Assistant tool calls | Identified by `tool_calls[].id` | Identified by `tool_calls[].function` |
| Tool message association | `tool_call_id` (by ID) | `tool_name` (by name) |
| Conversion function | `toOpenAIMessages()` | Inline conversion in `chatOllamaNative()` |

In the Ollama native path, a reverse lookup map from `toolCallId` to `tool_name` is used for association.

**Error Handling Design:**

- `isSessionRelatedError()` — Lowercases the Error instance message and checks if it matches known patterns caused by session history. Always returns false for non-Error objects
- `formatLlmError()` — Converts connection errors, timeouts, authentication errors, rate limits, and server errors into clear user-friendly messages. Returns a default message for non-Error objects
- Context trimming (`trimSession()`) — Executes tool result truncation, message count limiting (MAX_SESSION_MESSAGES), and total character limiting (CONTEXT_MAX_CHARS) with recent message protection

### Scheduler (scheduler.ts)

Manages periodic execution and reminders:

```
┌─────────────────────────────────────────────────────┐
│ Scheduler                                           │
├─────────────────────────────────────────────────────┤
│ - schedules: Schedule[]      # Schedule data        │
│ - cronJobs: Map<id, CronJob> # Running cron jobs    │
│ - senders: Map<platform, fn> # Message send funcs   │
│ - agentRunners: Map<platform, fn> # AI exec funcs   │
├─────────────────────────────────────────────────────┤
│ + add(schedule): Schedule                          │
│ + remove(id): boolean                              │
│ + toggle(id): Schedule                             │
│ + list(): Schedule[]                               │
│ + startAll(): void                                 │
│ + stopAll(): void                                  │
└─────────────────────────────────────────────────────┘
```

**Schedule Types:**
- `cron`: Periodic execution via cron expressions
- `once`: One-time reminder (executes once at a specified time)

**Persistence:**
- JSON file (`${DATA_DIR}/schedules.json`)
- Monitors file changes for automatic reload (with debounce)

**Timezone:**
- Follows the server's system timezone (`TZ` environment variable)
- In Docker environments, setting `TZ=Asia/Tokyo` etc. is recommended

### Tool Server (tool-server.ts)

An HTTP API server that allows AI CLIs to safely invoke xangi features (Discord operations, scheduling, system control).

```
AI CLI (Claude Code, etc.)
  → xangi-cmd (shell script)
  → HTTP POST http://localhost:<port>/api/execute
  → tool-server (inside xangi process)
  → Discord REST API / Scheduler / Settings
```

**Port Management:**
- Binds to port 0 (OS auto-assigns, no conflicts with multiple instances)
- The started URL is injected into child processes as `XANGI_TOOL_SERVER`
- `xangi-cmd` connects using `XANGI_TOOL_SERVER`
- Execution context such as the current channel ID is passed to tool-server via the `context` field of the HTTP request

**Security:**
- Secrets such as DISCORD_TOKEN remain inside the xangi process only
- AI CLIs receive only safe environment variables via the whitelist in `safe-env.ts`
- GitHub App private keys are loaded into memory at startup; token generation is handled via the tool-server's `/github-token` endpoint (only short-lived tokens are accessible)

### Approval Flow (approval.ts / approval-server.ts)

Detects dangerous commands (e.g., `rm -rf`, `git push --force`) in AI output and requires user approval before execution.

```
AI CLI outputs command
  → approval.ts pattern matches (approval-patterns.json)
  → Dangerous command detected
  → approval-server.ts sends button-attached message to Discord/Slack
  → User approves/rejects
  → Result returned to AI CLI
```

- Enabled via `APPROVAL_ENABLED=true` (disabled by default)
- Patterns defined in `src/approval-patterns.json`

### GitHub App Authentication (github-auth.ts)

Generates Installation Tokens (short-lived, 1-hour validity) using a GitHub App private key and wraps the `gh` CLI.

```
gh command execution (inside AI CLI)
  → /tmp/xangi-gh-wrapper/gh (wrapper)
  → curl to tool-server's /github-token endpoint
  → github-auth.ts generates token using in-memory private key
  → Injected as GH_TOKEN → exec real gh
```

- Private key is read from file into memory at startup; file access is no longer needed
- AI agent (child processes) cannot directly access the private key
- No fallback to PAT on token generation failure (errors out)

### Trigger Feature (local-llm/triggers.ts)

In Local LLM chat mode, detects magic words in LLM response text and automatically executes scripts.

```
triggers/
├── my-trigger/
│   ├── trigger.yaml    # Defines name, description, handler
│   └── handler.sh      # Execution script
```

- Reads `trigger.yaml` from the workspace's `triggers/` directory
- Executes the handler when trigger words are found in LLM response text

### Skill System (skills.ts)

Loads skills from the `skills/` directory in the workspace and registers them as slash commands.

```
skills/
├── my-skill/
│   ├── SKILL.md      # Skill definition
│   └── scripts/      # Execution scripts
└── another-skill/
    └── SKILL.md
```

## Data Flow

### Message Processing Flow

```
1. User sends a message
   ↓
2. Discord/Slack client receives it
   ↓
3. Permission check (allowedUsers)
   ↓
4. Special command detection
   - /command → Slash command handling
   ↓
5. Attach channel info and sender info
   ↓
6. Forward to AI CLI (processPrompt)
   ↓
7. Response processing
   - Streaming display
   - File attachment extraction (MEDIA: pattern)
   - SYSTEM_COMMAND detection
   ↓
8. Reply to user
```

### Schedule Execution Flow

```
1. Cron/timer triggers
   ↓
2. Scheduler.executeSchedule()
   ↓
3. agentRunner(prompt, channelId)
   - Execute prompt via AI CLI
   ↓
4. sender(channelId, result)
   - Send result to channel
   ↓
5. Auto-delete if one-time
```

## Design Philosophy

### User Management

xangi's user management uses a simple allowlist approach:

- Access control via `DISCORD_ALLOWED_USER` / `SLACK_ALLOWED_USER`
- Multiple users can be specified with commas; `*` allows everyone
- Sessions are managed per channel
- Sender info (display name, Discord ID) is automatically injected into the prompt

### AI CLI Abstraction

Hides AI CLI implementation details and makes them interchangeable:

```typescript
// Switch backends via configuration
AGENT_BACKEND=claude-code  // or codex or gemini or local-llm
```

When new AI CLIs emerge in the future, support can be added simply by creating a new adapter.

### Autonomous Command Execution

Detects and automatically executes special commands output by the AI:

| Method | Command Example | Action |
|--------|----------------|--------|
| CLI tool | `xangi-cmd discord_send --channel ID --message "..."` | Discord operations |
| CLI tool | `xangi-cmd discord_buttons --channel ID --message "..." --buttons "..."` | Button-attached message |
| CLI tool | `xangi-cmd schedule_add --input "Daily 9:00 ..."` | Schedule operations |
| CLI tool | `xangi-cmd system_restart` | Process restart |
| Text parsing | `MEDIA:/path/to/file` | File sending |
| Text parsing | `\n===\n` | Message splitting |
| Slash command | `/autoreply` | Toggle mention-free auto-reply per channel |

CLI tools (`xangi-cmd`) are executed via xangi's built-in tool-server (HTTP endpoint).
Secrets such as DISCORD_TOKEN are confined to the xangi process and cannot be accessed from AI CLIs.

### Persistence Strategy

| Data | Storage Location | Format |
|------|-----------------|--------|
| Schedules | `${DATA_DIR}/schedules.json` | JSON |
| Runtime settings | `${WORKSPACE}/settings.json` | JSON |
| Sessions | `${DATA_DIR}/sessions.json` | JSON (appSessionId-based, activeByContext + sessions) |
| Transcripts | `logs/sessions/{appSessionId}.jsonl` | JSONL (per-session conversation logs) |
| Process PID | `${DATA_DIR}/xangi.pid` | Text (used by `xangi-cmd system_restart` to send SIGTERM; removed on shutdown) |

### Session Management

Sessions are managed using xangi's own `appSessionId`. The backend's `providerSessionId` (e.g., Claude Code's session_id) is saved after the response.

**sessions.json Structure:**
```json
{
  "activeByContext": { "<contextKey>": "<appSessionId>" },
  "sessions": {
    "<appSessionId>": {
      "id": "<appSessionId>",
      "title": "...",
      "platform": "discord|slack|web",
      "contextKey": "<channelId>",
      "agent": { "backend": "claude-code", "providerSessionId": "..." }
    }
  }
}
```

### Transcript Logs

Automatically saves per-session AI conversation logs in JSONL format. Used for debugging, incident analysis, and WebUI browsing.

**Directory Structure:**
```
logs/sessions/
  m4abc123_def456.jsonl   # Per-session logs
  m4xyz789_ghi012.jsonl
```

**Recorded Content:**
- `user`: Prompt sent by the user
- `assistant`: AI's final response
- `error`: Timeouts, API errors, etc.

**Notes:**
- Logs are excluded via `.gitignore`
- Automatic rotation (directory split by date)
- Log write failures are ignored (no impact on core functionality)

## File Structure

```
bin/
└── xangi-cmd           # CLI wrapper (shell script, relays to tool-server)

src/
├── index.ts            # Entry point, Discord integration
├── slack.ts            # Slack integration
├── agent-runner.ts     # AI CLI interface
├── base-runner.ts      # System prompt generation
├── claude-code.ts      # Claude Code adapter (per-request)
├── persistent-runner.ts # Claude Code adapter (persistent process)
├── codex-cli.ts        # Codex CLI adapter
├── gemini-cli.ts       # Gemini CLI adapter
├── web-chat.ts         # Web Chat UI (HTTP server)
├── tool-server.ts      # Tool Server (HTTP API for AI CLIs)
├── approval.ts         # Dangerous command detection (pattern matching)
├── approval-server.ts  # Approval server (Discord/Slack interactive approval flow)
├── github-auth.ts      # GitHub App authentication (in-memory key management & token generation)
├── backend-resolver.ts # Per-channel backend resolution
├── dynamic-runner.ts   # Dynamic runner manager
├── safe-env.ts         # Environment variable whitelist
├── constants.ts        # Application-wide constants
├── schedule-cli.ts     # Scheduler CLI (legacy, migrated to tool-server)
├── cli/                # CLI modules (called from tool-server)
│   ├── discord-api.ts  #   Discord REST API calls
│   ├── schedule-cmd.ts #   Schedule operations
│   ├── system-cmd.ts   #   System operations
│   └── xangi-cmd.ts    #   Node.js CLI entry point
├── local-llm/          # Local LLM adapter
│   ├── runner.ts       #   Main runner (session management, tool execution loop)
│   ├── llm-client.ts   #   LLM API client (Ollama native + OpenAI compatible)
│   ├── context.ts      #   Workspace context loading
│   ├── tools.ts        #   Built-in tools (exec/read/web_fetch)
│   ├── xangi-tools.ts  #   xangi-specific tools (function calling version)
│   ├── image-utils.ts  #   Image processing utilities (multimodal support)
│   ├── triggers.ts     #   Trigger feature (magic word detection & execution in chat mode)
│   └── types.ts        #   Type definitions
├── prompts/            # Prompt definitions
│   ├── index.ts                   # Export aggregation
│   ├── xangi-commands.ts          # Per-platform assembly
│   ├── xangi-commands-common.ts   # Common (timeout handling, etc.)
│   ├── xangi-commands-chat-platform.ts # Chat platform common (MEDIA:/schedule/system)
│   ├── xangi-commands-discord.ts  # Discord-specific (xangi-cmd discord_*)
│   ├── xangi-commands-slack.ts    # Slack-specific
│   ├── xangi-commands-web.ts      # Web-specific
│   ├── chat-system-persistent.ts  # System prompt for persistent process
│   ├── chat-system-resume.ts      # System prompt for session resume
│   ├── platform-labels.ts         # Platform display name labels
│   └── tools-usage.ts             # Tool usage prompt for Local LLM
├── scheduler.ts        # Scheduler
├── skills.ts           # Skill loader
├── config.ts           # Configuration loading
├── settings.ts         # Runtime settings
├── sessions.ts         # Session management
├── file-utils.ts       # File operation utilities
├── process-manager.ts  # Process management
├── runner-manager.ts   # Multi-channel concurrent processing (RunnerManager)
└── transcript-logger.ts # Per-session transcript logging
```

## Docker Architecture

### Container Structure

```
┌─────────────────────────────────────────┐
│ xangi-max / xangi-gpu container         │
├─────────────────────────────────────────┤
│ - Node.js 22 + AI CLI + uv + Python    │
│ - xangi-gpu additionally has CUDA +    │
│   PyTorch                               │
└───────────────┬─────────────────────────┘
                │ docker network
┌───────────────▼─────────────────────────┐
│ ollama container                        │
├─────────────────────────────────────────┤
│ - Ollama official image                 │
│ - GPU passthrough                       │
│ - Connect via ollama:11434              │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│ llama-server container (optional)       │
├─────────────────────────────────────────┤
│ - llama.cpp official image              │
│ - GPU passthrough                       │
│ - Connect via llama-server:18080        │
└─────────────────────────────────────────┘
```

### Security Policy

- Runs as non-root user (UID 1000)
- Only the workspace is mounted
- Environment variables for the AI agent are restricted via whitelist (`src/safe-env.ts`)
- No direct access to host network (only via ollama container)

For details (environment variable reference, Docker operation methods, etc.), see the [Usage Guide](usage.md).

## Extension Points

### Adding a New Chat Platform

1. Add client initialization code
2. Implement the message handler
3. Register the send function via `scheduler.registerSender()`
4. Register the AI execution function via `scheduler.registerAgentRunner()`

### Adding a New AI CLI

1. Implement the `AgentRunner` interface
2. Add backend configuration to `config.ts`
3. Add initialization logic to `index.ts`
