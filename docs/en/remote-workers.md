# Remote workers (MVP)

On macOS, `xangi worker restart` rebuilds the launchd command from the current CLI while preserving pairing credentials. TypeScript checkouts register an absolute loader URL. `status` requires a running launchd process with a PID; check Gateway connectivity separately with `xangi tool remote_worker --action list`.

Remote workers let xangi use compute resources and attached devices on macOS, Linux, and Windows. The worker opens an outbound WebSocket connection to the xangi Gateway, so the worker does not require an inbound port or SSH login.

The MVP provides `system.info`, `exec`, and `usb.list`. Command execution uses an argv array without a shell and requires both an allowed workspace root and an allowlisted executable. USB writes and serial control are intentionally excluded until they can be granted per device and operation.

The recommended onboarding path uses a single-use pairing URI that expires after ten minutes:

```bash
xangi tool remote_worker --action pair-create --worker my-mac \
  --gateway-url ws://100.86.210.85:18791/api/remote-workers/connect
xangi worker install --pair 'xangi-pair://...' --workspace /Users/you/project
xangi worker status
```

On macOS, `worker install` stores the credential and configuration with mode 0600 and installs `dev.xangi.worker` as a launchd agent. It starts only worker mode, not the model, Web UI, chat platforms, or scheduler. Use `xangi worker start|stop|restart|status|uninstall` to manage it.

Manual configuration remains available. Configure the Gateway with a registration file and a dedicated listener. Token files must use mode 0600 on Unix systems. The remote-worker listener is separate from xangi's internal tool server.

```dotenv
XANGI_REMOTE_WORKERS_CONFIG=/absolute/path/to/workers.json
XANGI_REMOTE_WORKER_HOST=0.0.0.0
XANGI_REMOTE_WORKER_PORT=18791
```

```json
[{ "id": "my-mac", "tokenFile": "/absolute/path/to/my-mac.token" }]
```

Run the node with a local configuration:

```json
{
  "gatewayUrl": "ws://100.86.210.85:18791/api/remote-workers/connect",
  "workerId": "my-mac",
  "tokenFile": "/Users/you/.config/xangi/remote-worker.token",
  "workspaceRoots": ["/Users/you/project"],
  "allowedCommands": ["/usr/bin/git", "/opt/homebrew/bin/node", "/opt/homebrew/bin/npm"]
}
```

```bash
xangi worker run --config /absolute/path/to/worker.json
xangi tool remote_worker --action info --worker my-mac
xangi tool remote_worker --action exec --worker my-mac \
  --argv-json '["git","status","--short"]' --cwd /Users/you/project
```

The command allowlist uses exact string matching; absolute executable paths are recommended. The MVP uses `ws://` and therefore assumes an encrypted private network such as a Tailnet. Do not expose the listener to the public Internet; use a future native `wss://` transport or a TLS reverse proxy instead.

## Linux / WSL2 installation and management

Linux / WSL2 uses the same commands with a systemd user service. Node.js 22+ and an accessible user manager are required; check with `systemctl --user show-environment` first.

```bash
xangi worker install --pair 'xangi-pair://...' --workspace "$HOME/project"
xangi worker status
xangi worker restart
```

`install` saves mode-0600 credentials/configuration under `~/.config/xangi/worker/`, writes `~/.config/systemd/user/xangi-worker.service` (respecting `XDG_CONFIG_HOME` for the unit), and enables/starts it. Existing configuration is not overwritten: use `restart` or `uninstall`. Restart regenerates the unit from the current CLI without replacing credentials. `start`, `stop`, and `uninstall` are also supported. Uninstall stops/disables the service and removes only its unit, configuration, and token.

Status requires ActiveState=active, SubState=running, and a nonzero MainPID; retrying/failed services are not reported as running. Check Gateway connectivity separately with `remote_worker --action list`. Read logs with `journalctl --user -u xangi-worker.service -n 50`. If installation saves credentials but fails to start the service, fix the cause and use `restart` to recover with the saved credentials.

If WSL2 systemd is disabled, preserve existing `/etc/wsl.conf` settings and add `systemd=true` under `[boot]`, run `wsl --shutdown` in PowerShell (terminating other WSL work), then reopen WSL. Ubuntu/Debian also requires systemd and systemd-sysv. An unavailable user manager causes an error before the pairing code is consumed.

This manages a user service while WSL is running. It does not configure Windows boot tasks, launch WSL automatically, or keep WSL itself alive. Systemd services alone do not guarantee WSL stays alive. Native Windows Task Scheduler support is not included.

Reference: https://learn.microsoft.com/en-us/windows/wsl/systemd
