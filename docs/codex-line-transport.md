# LINE Codex transport

`CODEX_LINE_TRANSPORT=exec` (default) keeps the existing per-message CLI. Set
`CODEX_LINE_TRANSPORT=app-server` to reuse Codex processes **only for incoming LINE
conversation messages**. LINE scheduled jobs and other platforms still use exec.
Model/effort remain independently configured with `AGENT_MODEL` / `AGENT_EFFORT`.

## Lifecycle and isolation

Known allowed LINE users are warmed at startup. Wildcard users start lazily.
Each conversation owns a process because `XANGI_CHANNEL_ID`, tool environment and
workspace must not leak between users. The existing resolver chooses the model,
effort, workspace and permissions; the existing LINE queue serializes turns.
Threads are resumed once per process and reused until reset/restart. The provider's
effective sandbox policy is preserved, rather than replacing its configured roots
or network settings. Unsupported interactive approvals fail closed.

Initialization and control RPCs are bounded to 15 seconds. Generation uses the
existing timeout/extension controller. Cancellation sends `turn/interrupt`; no
completion after 5 seconds terminates the owned process group. EOF, exit, malformed
protocol and shutdown reject pending work and clear the connection. The next
request starts a new process. An uncertain turn is never replayed automatically.
There is no automatic exec fallback. No new public port, PM2 service or schedule is
created. Existing PM2 shutdown owns the children.

Usage comes from `thread/tokenUsage/updated`, including last-context usage and
provider cumulative usage (matching exec). Actual model/effort evidence is read
from the bounded local turn log; this does not spawn/resume another Codex process.
Transport timing events carry fixed stages only; no message/tool content or secrets
are added to timing logs. Existing transcript storage behavior is unchanged.

## Validation and rollback

Run `npm run typecheck`, `npm run lint`, `npm run build`, and the tests before rollout.

For isolated performance comparison after building:

```sh
BENCH_WORKSPACE="$HOME/.local/state/xangi-codex-benchmark/workspace" \
BENCH_OUTPUT="$HOME/.local/state/xangi-codex-benchmark/results.jsonl" \
BENCH_MODEL="your-codex-model" \
BENCH_SETS=10 node scripts/benchmark-codex-line.mjs
```

Use a new output file per experiment. `BENCH_MODEL` is optional and defaults to
the Codex CLI's configured model; `BENCH_EFFORT` defaults to `medium`. The script
alternates the order of exec and app-server, with three identical synthetic messages
per set. It sends no LINE
messages and uses a dedicated workspace, never the production conversation. The
app-server is warmed before the first message, matching startup behavior. Initial
turns and continuation turns are reported separately. `preparedMs` uses the actual
provider `turn_context` timestamp relative to invocation; backend-ready alone does
not prove the model input is ready. Both transports include the same xangi prompt,
but provider built-in context/cache may differ; this is an end-to-end transport
comparison, not an isolated model-speed benchmark.

Accept only when continuation preparation median improves at least 20%, total
median does not regress, all continuity checks pass and fault tests pass. Keep the
same model and effort for both transports. Back up the local configuration before
rollout, wait for active LINE work to finish, then restart xangi. Verify a user-sent
message before calling production validation complete.

Rollback: set `CODEX_LINE_TRANSPORT=exec`, then restart xangi.
Keep session state; do not restore the entire `.env` over unrelated newer changes.

## Example Pi result (2026-09-22, Codex CLI 0.155.1)

10 sets per transport, 3 messages per set, alternating order (60 turns).
All turns used `gpt-5.6-luna / medium`; continuity passed throughout; no tools were
used in the timing sample. Values below are milliseconds, median / maximum.

| Transport | Turn | Preparation | Total agent execution |
| --- | --- | ---: | ---: |
| exec | Initial | 2068 / 2955 | 4566 / 5706 |
| app-server (warmed) | Initial | 1604.5 / 1934 | 3820 / 4977 |
| exec | Continuation | 1852.5 / 4178 | 3989.5 / 5872 |
| app-server | Continuation | 27 / 147 | 1722 / 3558 |

Continuation preparation improved 98.5%; total agent median improved 56.8%.
These are synthetic Pi measurements, not handset end-to-end delivery measurements.
The production LINE turn still includes webhook arrival, hooks and LINE API latency.
