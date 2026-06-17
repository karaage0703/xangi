# External Event Stream (Pull SSE)

xangi exposes its response lifecycle as Server-Sent Events (SSE). Consumers such as desktop avatars, dashboards, visualizers, or glasses clients can connect to `GET /api/events/stream` and observe what the running xangi instance is doing.

Events are emitted across Discord, Slack, Web Chat, and Line. Consumers should branch on `platform`, `thread_id`, and `thread_label`.

## Endpoint

```text
GET http://<xangi-host>:<WEB_CHAT_PORT>/api/events/stream
```

- Served by the Web Chat HTTP server (default port: `18888`)
- `Content-Type: text/event-stream`
- Sends one initial `event: ready` frame with `instance_id` and `host_hint`
- Supports server-side thread filtering with `?thread_id=web:<appSessionId>`
- Sends operation events as `data: <JSON>\n\n`
- Sends `: keepalive` comments every 30 seconds

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `WEB_CHAT_PORT` | `18888` | HTTP server port for Web Chat and SSE |
| `XANGI_EVENTS_ENABLED` | `true` | Set to `false` to disable event streaming (connections return 503) |
| `XANGI_INSTANCE_ID` | `xangi-<hostname>-<sha1(DATA_DIR)[:6]>` | Stable instance identifier used by consumers for filtering |

If `XANGI_INSTANCE_ID` is not set, xangi derives it from hostname and `DATA_DIR`. Same machine + same `DATA_DIR` keeps the same ID across restarts; same machine + different `DATA_DIR` gets a different ID.

## Event Schema

Initial ready frame:

```jsonc
{ "instance_id": "xangi-prod", "host_hint": "<hostname>", "thread_id": "web:<appSessionId>" }
```

Common fields:

```jsonc
{
  "type":         "<event type>",
  "instance_id":  "xangi-prod",
  "host_hint":    "<hostname>",
  "platform":     "discord",
  "thread_id":    "discord:<channelId>",
  "turn_id":      "discord-msg-<messageId>",
  "thread_label": "#general",
  "ts":           1730000000
}
```

Event types:

| Type | Description |
|---|---|
| `turn.started` | One frame when xangi receives a user message |
| `message.delta` | Streaming assistant text delta |
| `turn.complete` | One frame when the turn completes successfully |
| `turn.aborted` | One frame when the user cancels the turn |
| `agent.error` | One frame when the agent fails |

Normal turn flow:

```text
turn.started -> message.delta x N -> turn.complete
```

## Pet / Device Input (`POST /api/*/inbox`)

xangi also exposes small write endpoints for external UI clients such as `xangi-pet`, Even G2, and terminal-style devices.

```text
POST http://<xangi-host>:<WEB_CHAT_PORT>/api/pet/inbox
POST http://<xangi-host>:<WEB_CHAT_PORT>/api/device/inbox
POST http://<xangi-host>:<WEB_CHAT_PORT>/api/terminal/inbox
Content-Type: application/json
Authorization: Bearer <TOKEN>   # required only when a token is configured

{
  "text": "What is today's weather?",
  "appSessionId": "<optional>",
  "source": "g2"
}
```

Success returns 202 immediately. The agent response is broadcast through `/api/events/stream`.

```jsonc
{
  "accepted": true,
  "instance_id": "xangi-prod",
  "thread_id": "web:<appSessionId>",
  "turn_id": "web-msg-pet-<unix-ms>",
  "session_id": "<appSessionId>",
  "events_url": "/api/events/stream?thread_id=web%3A<appSessionId>"
}
```

Environment variables:

| Variable | Default | Description |
|---|---|---|
| `XANGI_PET_INBOX_ENABLED` | `true` | Set to `false` to disable all pet/device inbox writes |
| `XANGI_PET_INBOX_TOKEN` | unset | Fallback token for pet/device/terminal routes |
| `XANGI_DEVICE_INBOX_ENABLED` | `true` | Set to `false` to disable `/api/device/inbox` and `/api/terminal/inbox` |
| `XANGI_DEVICE_INBOX_TOKEN` | unset | Token for device/terminal routes; falls back to `XANGI_PET_INBOX_TOKEN` |

When no token is configured, xangi only accepts loopback, RFC1918 LAN, Tailscale CGNAT (`100.64.0.0/10`), IPv6 link-local, and IPv6 ULA clients. Public IP requests return 403.

## Even Terminal Compatibility API

xangi implements a minimal compatibility layer for the HTTP API expected by `@evenrealities/even-terminal`. This lets the Even G2 Terminal mode connect to xangi as the host server.

The Even Terminal UI only exposes `claude` and `codex` provider labels. xangi accepts those labels for compatibility, but the actual backend is still chosen by xangi's normal configuration:

```text
AGENT_BACKEND=claude-code | codex | cursor | grok | local-llm
```

Local LLM works by setting `AGENT_BACKEND=local-llm` on the xangi side, then choose either provider label in the Even UI.

To use a different backend / model / Local LLM mode only for Even Terminal traffic, set `XANGI_EVEN_TERMINAL_BACKEND`, `XANGI_EVEN_TERMINAL_MODEL`, and `XANGI_EVEN_TERMINAL_LOCAL_LLM_MODE`. Per-session `CHANNEL_OVERRIDES` entries for `web-chat:<appSessionId>` take precedence over these Even Terminal defaults.

### Authentication

Use the same token forms as Even Terminal:

```text
Authorization: Bearer <TOKEN>
?token=<TOKEN>
```

Token resolution order:

1. `XANGI_EVEN_TERMINAL_TOKEN`
2. `XANGI_DEVICE_INBOX_TOKEN`
3. `XANGI_PET_INBOX_TOKEN`

If no token is configured, only loopback / LAN / Tailscale clients are allowed.

### Endpoints

```text
GET  /api/sessions?provider=codex&token=<TOKEN>
GET  /api/info?provider=codex&token=<TOKEN>
GET  /api/update-check?token=<TOKEN>
POST /api/prompt
GET  /api/events?sessionId=<appSessionId>&token=<TOKEN>&needReplay=true
GET  /api/messages?sessionId=<appSessionId>&token=<TOKEN>&after=0
GET  /api/status?sessionId=<appSessionId>&token=<TOKEN>
POST /api/permission-response
POST /api/question-response
POST /api/interrupt
```

`POST /api/prompt`:

```jsonc
{
  "text": "input from G2",
  "sessionId": "<optional xangi web appSessionId>",
  "provider": "codex"
}
```

Success:

```jsonc
{ "ok": true, "sessionId": "<appSessionId>", "provider": "codex" }
```

The response is asynchronous. The Even client should subscribe to `/api/events`.

### Event Message Mapping

| xangi event | Even Terminal-compatible message |
|---|---|
| `turn.started` | `{ "type": "user_prompt", "text": "..." }` |
| `message.delta` | `{ "type": "text_delta", "text": "..." }` |
| `turn.complete` | `{ "type": "result", "success": true, "text": "..." }` |
| `turn.aborted` | `{ "type": "result", "success": false, "text": "Turn aborted" }` |
| `agent.error` | `{ "type": "error", "message": "..." }` |

`permission-response`, `question-response`, and `interrupt` currently return `{"ok":true,"ignored":true}` for protocol compatibility. xangi's approval and question flows are still handled through its existing chat-platform mechanisms.

### Curl Check

```bash
WEB_CHAT_ENABLED=true
WEB_CHAT_PORT=18889
XANGI_EVEN_TERMINAL_TOKEN=evtest123
XANGI_EVEN_TERMINAL_BACKEND=local-llm
XANGI_EVEN_TERMINAL_MODEL=gemma-4-26b-a4b
XANGI_EVEN_TERMINAL_LOCAL_LLM_MODE=chat

curl 'http://127.0.0.1:18889/api/sessions?provider=codex&token=evtest123'

curl -X POST 'http://127.0.0.1:18889/api/prompt' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer evtest123' \
  -d '{"text":"hello","provider":"codex"}'
```
