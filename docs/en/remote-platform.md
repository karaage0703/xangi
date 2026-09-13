# Remote Platform Adapter (experimental)

The Remote Platform Adapter lets a host gateway retain Discord or Slack credentials while xangi owns normal sessions, agent execution, and shared lifecycle events. It is an internal API for isolated deployments such as NemoXangi, not a public Internet API.

Enable `XANGI_REMOTE_PLATFORM_ENABLED=true`, set a long random `XANGI_REMOTE_PLATFORM_TOKEN`, and bind the shared HTTP server to loopback or an isolated network. `POST /api/remote-platform/turn` requires a Bearer token and streams `started`, `text`, `tool`, `error`, and `done` SSE events. Concurrent turns for the same xangi session are rejected with HTTP 409.

The adapter token is not a platform credential, but it authorizes callers to inject turns. Keep it only between the host gateway and xangi. Never pass raw Discord or Slack tokens to xangi or its agent process.
