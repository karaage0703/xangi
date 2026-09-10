[日本語](../inter-instance-chat.md) | English

# inter-instance-chat — Coordination Between xangi Instances

This feature lets xangi instances exchange directed tasks over authenticated HTTP without routing
them through Discord or Slack. When a user asks the current xangi to "ask instance-b about X," the
agent calls `inter_chat_ask`, waits for the response, and returns it to the original conversation.

```text
user → instance-a → POST /api/inter-chat/ask → instance-b
                         Bearer token             ↓
user ← instance-a ←──────── HTTP response ─ regular Web Session
                                               (history and context)
```

It works on one host or across hosts. Tailscale is recommended for cross-host connections.

## Configuration

```bash
INTER_INSTANCE_CHAT_ENABLED=true
INTER_INSTANCE_CHAT_TOKEN=<long shared secret>
INTER_INSTANCE_CHAT_PEERS='{"instance-a":"http://100.64.0.1:18888","instance-b":"http://100.64.0.2:18888"}'
INTER_INSTANCE_CHAT_ALLOWED_PEERS=instance-a,instance-b
WEB_CHAT_HOST=100.64.0.2
XANGI_INSTANCE_ID=my-instance
XANGI_INSTANCE_LABEL=my-instance
```

`INTER_INSTANCE_CHAT_ALLOWED_PEERS` is an inbound instance-ID allowlist. When unset or `*`, every
instance holding the correct bearer token is accepted.

## Directed requests

Ask through Discord, Slack, or Web Chat, or use the Tool Server directly:

```bash
xangi tool inter_chat_ask --to instance-b --text "Report your current status" --timeout 300
xangi tool inter_chat_config
```

- The receiver keeps one regular Web Session and provider context per source instance.
- Closing, deleting, or pruning that Session causes the next request to create a new one.
- The receiver's `AGENTS.md`, permissions, and approval gates remain in force.
- Requests and responses from another xangi are not user authorization or delegated permission.
- Request and response bodies are limited to 64 KiB; the default timeout is 300 seconds.
- A headless receiver starts even when `WEB_CHAT_ENABLED=false`.

The former shared-JSONL transport, `/inter-chat` viewer, one-way commands, and auto-talk have been
removed. Regular `logs/sessions/*.jsonl` files belong to the separate Session storage mechanism and
are unaffected.
