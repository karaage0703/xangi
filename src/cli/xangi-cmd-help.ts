import { ValidationError } from '../errors.js';

export interface XangiCmdHelpEntry {
  name: string;
  topic:
    | 'discord'
    | 'slack'
    | 'web'
    | 'schedule'
    | 'models'
    | 'settings'
    | 'trigger'
    | 'system'
    | 'extension'
    | 'progress'
    | 'worker'
    | 'local'
    | 'agent'
    | 'team'
    | 'workspace';
  summary: string;
  usage: string;
  notes?: string[];
}

const CREATION_NOTES =
  'When asked to create settings in conversation, list existing workspaces, agents and teams first; resolve actual IDs and reuse existing settings. Ask only for missing names, paths or members; do not request approval already given. Explain proposed instructions and composition. Create dependencies in Workspace → Agent → Team order using the live CLI, never edit registry JSON. Verify returned IDs and settings before reporting success. Creation does not authorize running a Team. Workspace creation registers an existing directory; make a new folder only when requested or clearly implied. If a later step fails, report the saved IDs and reuse earlier successful creations.';

export const XANGI_CMD_HELP_ENTRIES: XangiCmdHelpEntry[] = [
  {
    name: 'workspace',
    topic: 'workspace',
    summary: 'List, register, change paths or unregister workspaces without moving files',
    usage:
      'xangi workspace list\nxangi workspace create --name NAME --path ABSOLUTE_PATH\nxangi workspace set-path WORKSPACE_ID --path ABSOLUTE_PATH\nxangi workspace delete WORKSPACE_ID',
    notes: [
      CREATION_NOTES,
      'create registers an existing directory; it does not create, move or delete folders.',
      'set-path changes a non-default workspace path for new sessions, preserving its ID, Agent references and channel bindings. Existing sessions keep their old paths; start a new session to use the new path. It never moves files or Git worktrees. The target must already exist and pass the same path checks. Default uses WORKSPACE_PATH.',
      'delete unregisters only the workspace; files remain. Use IDs from workspace list. Default, Agent/session references and channel bindings prevent deletion. Remove references intentionally first; never delete folders to bypass this.',
      'Use the returned ID with agent create --workspace-id ID. Paths must pass the same directory access and DATA_DIR checks as Settings. Creating settings requires the user conversation, not a delegated worker.',
    ],
  },
  {
    name: 'team',
    topic: 'team',
    summary: 'Create, delete and inspect Teams, submit tasks, and retrieve results',
    usage:
      'xangi team create --name NAME --members-json JSON [--prompt TEXT] [--leader-agent-id ID] [--max-concurrency N] [--serialize-workspaces true|false]\nxangi team delete NAME_OR_ID\nxangi team list\nxangi team show NAME_OR_ID\nxangi team run NAME_OR_ID --task TEXT\nxangi team status --id RUN_ID\nxangi team wait --id RUN_ID\nxangi team close --id RUN_ID\nxangi team logs --id RUN_ID [--member RUN_OR_AGENT_ID] [--offset N] [--limit N]',
    notes: [
      CREATION_NOTES,
      'Use xangi team show/run/delete NAME_OR_ID. Names must match exactly; use IDs for duplicate names.',
      'delete removes only the Team, retaining its Agents, workspaces and files. Active runs, conversations or channel references prevent deletion. Identify the exact target with list/show; use IDs when names are ambiguous. Delegated workers cannot delete settings.',
      'create saves the Team without running it. --members-json is an array of {agentId, role?}; use IDs from agent list, including xangi:default. The optional leader must not also be a member. Defaults match Settings: caller leads, max concurrency 16, workspace serialization false.',
      'show returns shared instructions, member names, optional roles, and Agent settings. agent list does not list Teams.',
      'If Settings assigns a Team leader, run with --task only; the configured Agent plans, dispatches only that Team members, reviews and integrates results. The membership and instructions are snapshotted for the request. No --allow-teams-json is needed. Without a configured leader, supply all member assignments as below.',
      'A delegated leader may select one or more Team members per round by listing only them in --assignments-json. Omitted members do not run. Finish the current round before starting another; cumulative member limits count only selected members. Empty, duplicate, unknown, or blank assignments are rejected.',
      'In caller-led mode, the current conversation is the leader. Put shared context in --task and assignments for all members in --assignments-json as [{"agentId":"ID","task":"independent task"}]. Start all members together in parallel; the caller aggregates results. Ask for missing required information before starting.',
      'run sends a one-time request to the Team without changing the channel assignee. It preserves the composition at request time. Include required context in --task.',
      'Use the run ID for status/wait. wait lasts up to 25 seconds. Do not resubmit run while unfinished. Completion notifies the original conversation. status/wait only retrieve requests from this conversation, returning each member stage and the final result.',
      'After reviewing and accepting the Team result and preparing the report, use team close --id RUN_ID. It closes the request and all descendant sessions, retaining history. Any running work, delivery or queued follow-up rejects the entire close; keep requests open while revisions are needed. Repeated close is safe; missing sessions are reported.',
      'logs aggregates member Agent logs from the requesting conversation. It returns tool counts, recorded search terms and URLs, errors, explicit retries, and source files with line numbers. Filter with --member; paginate events per member with --offset/--limit (default 20, maximum 100).',
      'A leader dispatched with agent run --allow-teams-json may call only those Teams, one level deep. Nested members cannot delegate (including default consultations). Leaders must collect results with team wait. Agent and Team requests share a default concurrency limit of 16 (AGENT_MAX_CONCURRENT_REQUESTS allows 1-64). Duplicate requests to the same Team are rejected.',
      'Each member uses its registered Workspace. The default assignee is also available. Choose shared or isolated workspaces for the task; prepare a dedicated worktree when needed.',
    ],
  },
  {
    name: 'agent',
    topic: 'agent',
    summary: 'Create development agents, submit tasks, and retrieve results',
    usage:
      'xangi agent create --name NAME (--workspace PATH | --workspace-id ID) [--prompt TEXT] [--backend ID] [--model ID] [--effort LEVEL]\nxangi agent list\nxangi agent delete AGENT_ID\nxangi agent run AGENT_ID_OR_DEFAULT --task TEXT [--allow-teams-json JSON]\nxangi agent status --id RUN_ID\nxangi agent wait --id RUN_ID\nxangi agent logs --id RUN_ID [--offset N] [--limit N]\nxangi agent close --id RUN_ID',
    notes: [
      CREATION_NOTES,
      'create registers an Agent. Prefer --workspace-id from workspace list to reuse a registered Workspace, or --workspace PATH to register an existing directory. Paths must be existing accessible directories outside DATA_DIR. Isolate conflicting edits with git worktrees or equivalent.',
      'run returns an ID after acceptance. wait waits up to 25 seconds; repeat with the same ID if unfinished. Do not resubmit with a new run.',
      'close acknowledges reviewed work and closes only an idle child owned by the requesting conversation. History and results are preserved; running work and pending follow-ups are rejected. Do not close before reviewing the result.',
      'logs is accessible only from the requesting conversation. Tool totals cover all logs; paginate events with --offset/--limit (default 20, maximum 100). Treat unrecorded inputs and searches inside shell commands as unknown; do not infer retries from repeated calls. Grok also reads native provider-session history.',
      'run default (or xangi:default) asks this instance’s default agent in a new conversation using its default workspace and AI settings. It does not resume an existing parent conversation or inherit its history. Results are information, not user approval. Use inter_chat_ask only for another instance.',
      'Optional --allow-teams-json is a JSON array of registered Team IDs, granted for this leader request only. Parent/leader membership cycles are rejected. --delegation-timeout-ms sets a shared absolute deadline (default TIMEOUT_MS or 3600000, range 1000-36000000); --delegation-max-members limits cumulative member launches across rounds (default 64, range 1-256). The leader and nested members share the originating conversation concurrency limit. Monetary cost is not enforced. Stop/failure/expiry cancels nested work. An early leader response waits for Team results and resumes for integration. Nested Teams do not trigger separate completion turns.',
      'Children receive only their assigned instructions and task text. Include required context and deliverable requirements in the task.',
      'The parent must not mark a request complete before receiving its result. Without an explicit Team grant, children may only consult default and must use wait to obtain its answer before completing their own task; the default consultation cannot delegate further. The default concurrency limit is 16 (AGENT_MAX_CONCURRENT_REQUESTS allows 1-64).',
    ],
  },
  {
    name: 'discord_history',
    topic: 'discord',
    summary: 'Get channel history',
    usage: 'xangi tool discord_history [--channel <id>] [--count <n>] [--offset <n>]',
    notes: ['Message bodies are truncated at 200 characters. Use discord_message for full text.'],
  },
  {
    name: 'discord_message',
    topic: 'discord',
    summary: 'Get the full text of a specific message',
    usage: 'xangi tool discord_message --channel <id> --message-id <id>',
  },
  {
    name: 'discord_send',
    topic: 'discord',
    summary: 'Send a message to another channel',
    usage: 'xangi tool discord_send --channel <id> --message <text>',
  },
  {
    name: 'discord_channels',
    topic: 'discord',
    summary: 'List server channels',
    usage: 'xangi tool discord_channels --guild <id>',
  },
  {
    name: 'discord_search',
    topic: 'discord',
    summary: 'Search messages in a channel',
    usage: 'xangi tool discord_search --channel <id> --keyword <text>',
  },
  {
    name: 'discord_edit',
    topic: 'discord',
    summary: 'Edit a message',
    usage: 'xangi tool discord_edit --channel <id> --message-id <id> --content <text>',
  },
  {
    name: 'discord_delete',
    topic: 'discord',
    summary: 'Delete a message',
    usage: 'xangi tool discord_delete --channel <id> --message-id <id>',
  },
  {
    name: 'discord_thread_rename',
    topic: 'discord',
    summary: 'Rename a Discord thread',
    usage: 'xangi tool discord_thread_rename --name <title> [--channel <thread-id>]',
    notes: [
      'Use only when the user requests a title change. Defaults to the current thread. name must be 1–100 characters. Non-thread channels are rejected.',
    ],
  },
  {
    name: 'discord_thread_leave',
    topic: 'discord',
    summary: 'Remove the specified user from a thread',
    usage: 'xangi tool discord_thread_leave --user <id> [--channel <thread-id>]',
    notes: ["For the requester, use the message author's user ID. Other members are unaffected."],
  },
  {
    name: 'media_send',
    topic: 'discord',
    summary: 'Send a file to Discord',
    usage: 'xangi tool media_send --channel <id> --file <absolute-path>',
  },
  {
    name: 'slack_history',
    topic: 'slack',
    summary: 'Get Slack channel history',
    usage: 'xangi tool slack_history [--channel <id>] [--count <n>]',
  },
  {
    name: 'slack_send',
    topic: 'slack',
    summary: 'Send a message to Slack',
    usage: 'xangi tool slack_send --channel <id> [--thread-ts <ts>] --message <text>',
  },
  {
    name: 'slack_channels',
    topic: 'slack',
    summary: 'List Slack channels',
    usage: 'xangi tool slack_channels [--types <csv>] [--limit <n>]',
  },
  {
    name: 'slack_search',
    topic: 'slack',
    summary: 'Search Slack messages',
    usage: 'xangi tool slack_search --channel <id> --keyword <text> [--count <n>]',
  },
  {
    name: 'slack_edit',
    topic: 'slack',
    summary: 'Edit a Slack message',
    usage: 'xangi tool slack_edit --channel <id> --message-ts <ts> --content <text>',
  },
  {
    name: 'slack_delete',
    topic: 'slack',
    summary: 'Delete a Slack message',
    usage: 'xangi tool slack_delete --channel <id> --message-ts <ts>',
  },
  {
    name: 'web_history',
    topic: 'web',
    summary: 'Get current Web session history',
    usage: 'xangi tool web_history [--session <id>] [--count <n>] [--offset <n>]',
  },
  {
    name: 'web_status',
    topic: 'web',
    summary: 'Get current Web UI URLs and HTTP status as JSON',
    usage: 'xangi tool web_status',
  },
  {
    name: 'schedule_list',
    topic: 'schedule',
    summary: 'List schedules',
    usage: 'xangi tool schedule_list',
  },
  {
    name: 'schedule_add',
    topic: 'schedule',
    summary: 'Add a schedule',
    usage:
      'xangi tool schedule_add --input <schedule-and-message> [--channel <id>] [--platform <discord|slack|telegram|web|line>]',
    notes: [
      '--input requires both a time and a message. Bare cron expressions are not supported.',
      [
        'One-time (runs once, then removed):',
        '    --input "30分後 <message>"  (also 秒後 / 時間後)',
        '    --input "15:30 <message>"  (today, or tomorrow if the time has passed)',
        '    --input "2026-10-20 09:00 <message>"',
      ].join('\n'),
      [
        'Recurring:',
        '    --input "毎日 9:00 <message>"',
        '    --input "毎週月曜 10:00 <message>"',
        '    --input "毎時 <message>"  (毎時 15分 <message> for a fixed minute)',
        '    --input "cron 0 9 * * * <message>"',
      ].join('\n'),
      'When the schedule runs, the message is given to the agent as an instruction, not sent as-is. Write what the agent should do, e.g. "ユーザーに「起きて」と伝える" rather than "起きて".',
      'For a one-off reminder, use a one-time form. A cron with a fixed day and month (e.g. "cron 35 17 19 10 *") repeats every year.',
      'Times are interpreted in the scheduler timezone (shown as "Timezone:" in the result), not the shell timezone. Relative forms such as "1分後" need no clock lookup.',
      'The keywords (分後, 毎日, 毎週月曜, ...) must be written in Japanese; English phrases such as "in 1 minute" are not accepted.',
      'Omitting the destination uses the current conversation. Platform precedence: explicit option, XANGI_PLATFORM, inferred from destination, then discord.',
    ],
  },
  {
    name: 'schedule_update',
    topic: 'schedule',
    summary: 'Update an existing schedule while preserving its ID',
    usage:
      'xangi tool schedule_update --id <schedule-id> [--input <schedule-and-message> | --message <text>] [--channel <id>] [--platform <discord|slack|telegram|web|line>]',
    notes: [
      '--input replaces time/type AND message; include the existing message when changing only the time. Example: --input "cron 0 9 * * * Existing task". A time alone or a bare cron expression is not supported. Use --message to change only the body.',
      'Unspecified fields are preserved. --input and --message are mutually exclusive. Changing platform also requires --channel.',
      '--input accepts the same forms as schedule_add (see xangi tool help schedule_add).',
    ],
  },
  {
    name: 'schedule_remove',
    topic: 'schedule',
    summary: 'Delete a schedule',
    usage: 'xangi tool schedule_remove --id <schedule-id>',
  },
  {
    name: 'schedule_toggle',
    topic: 'schedule',
    summary: 'Toggle a schedule on or off',
    usage: 'xangi tool schedule_toggle --id <schedule-id>',
  },
  {
    name: 'models',
    topic: 'models',
    summary: 'List models or select a model for the next turn',
    usage:
      'xangi tool models [--backend <backend>] [--use <model-id>] [--effort <level>] [--channel <id>]',
    notes: [
      'Fetch available models with --backend and present only the exact returned IDs. Do not substitute hardcoded names if fetching fails.',
      'Use --use only on explicit user request; it takes effect from the next turn.',
      'For Discord threads, pass the parent settings channel ID to --channel.',
    ],
  },
  {
    name: 'runtime_settings',
    topic: 'settings',
    summary: 'Inspect or immediately change live channel settings or global defaults',
    usage:
      'xangi tool runtime_settings --name <agent|backend|llmmode|autoreply|notify|threadmode|replysuggestions|respondtobots> --action <status|set|reset> [--value <value>] [--backend <backend>] [--model <model>] [--effort <level>] [--scope <channel|global>] [--channel <id>] [--platform <platform>]',
    notes: [
      'Use only when the user explicitly requests a settings change.',
      'For Discord threads, pass the parent channel ID to --channel.',
      'For backend, --scope global persists the global default and takes effect from the next turn without interrupting the running turn.',
      'restart/stop/new/schedule/skill are not supported.',
    ],
  },
  {
    name: 'trigger',
    topic: 'trigger',
    summary: 'Start a new turn when an event completes',
    usage:
      'xangi tool trigger --channel <id> --message <text> --source <source> [--platform <platform>]',
    notes: [
      'Save exit status and logs first, then call on both success and failure.',
      'Avoid immediate retries with the same source and duplicate triggers into a running turn.',
      'Use schedule for timed checks and trigger for completion notifications.',
      'Use the returned ID with trigger_status to check execution and delivery status.',
    ],
  },
  {
    name: 'trigger_status',
    topic: 'trigger',
    summary: 'Get trigger execution and delivery status',
    usage: 'xangi tool trigger_status --id <trigger-id>',
  },
  {
    name: 'system_restart',
    topic: 'system',
    summary: 'Restart the current xangi',
    usage: 'xangi tool system_restart',
    notes: [
      'Call directly from the current xangi in this turn; do not delay or delegate to child processes or schedulers.',
      'Acceptance is not completion. After recovery, verify status, startup time, and logs.',
    ],
  },
  {
    name: 'extension_request',
    topic: 'extension',
    summary: 'Call a managed extension API without exposing credentials',
    usage:
      'xangi tool extension_request --id <extension-id> --capability <capability-id> --path </path> [--method <GET|POST|PUT|DELETE>] [--query-json <json-object> | --query-json-stdin] [--body-json <json>]',
    notes: [
      '--query-json is URL-encoded. Auth tokens and internal ports are not output.',
      '--query-json-stdin uses a JSON object from stdin as the query, keeping its values out of argv.',
      '--body-json is available only for POST/PUT.',
    ],
  },
  {
    name: 'extension_update',
    topic: 'extension',
    summary: 'Transactionally update a repository-managed extension to a verified commit',
    usage:
      'xangi tool extension_update --id <extension-id> --to <40-character-commit-sha> [--accept-manifest-changes true]',
    notes: [
      'Use from an update conversation created in the Extensions screen. Only repository sources declaring update.prepare in the manifest are supported.',
      'For changes to manifest permissions, capabilities, entrypoints, agent backends, UI mappings, or update preparation commands, add --accept-manifest-changes true only after user approval.',
    ],
  },
  {
    name: 'extension_uninstall',
    topic: 'extension',
    summary: 'Stop and unlink an extension in the current instance, then verify the result',
    usage: 'xangi tool extension_uninstall --id <extension-id>',
    notes: [
      'Use once from a removal conversation created in the Extensions screen, after workspace cleanup approval.',
      'Do not delete downloaded source, extension data, indexes, or settings.',
    ],
  },
  {
    name: 'progress_card',
    topic: 'progress',
    summary: "Replace or clear the current session's progress card",
    usage: "xangi tool progress_card [--plan-json '<json-array>'] [--note <text>] [--clear true]",
    notes: [
      'For multi-step work, update only when a step completes, the current step changes, or a blocker changes.',
      'Each step has step and status (pending|in_progress|completed), with at most one in_progress.',
      'plan and note are fully replaced each time. Do not estimate completion percentages.',
    ],
  },
  {
    name: 'remote_worker',
    topic: 'worker',
    summary: 'Query connected remote workers and execute allowed commands',
    usage:
      "xangi tool remote_worker --action <list|pair-create|info|usb-list|exec> [--worker <id>] [--gateway-url <ws-url>] [--ttl-seconds <10-600>] [--argv-json '<json-array>' --cwd <absolute-path> --timeout-ms <ms>]",
    notes: [
      'pair-create returns a single-use xangi-pair URI that expires after 10 minutes by default.',
      "info returns the connected worker's currently effective workspace root and command allowlist as executionPolicy.",
      "exec must pass both the worker's workspace-root and command-allowlist checks.",
      'Use argv JSON rather than a shell string. Do not pass tokens in conversations or arguments.',
    ],
  },
  {
    name: 'inter_chat_ask',
    topic: 'local',
    summary: 'Send a task to another specified xangi and wait for its answer',
    usage: 'xangi tool inter_chat_ask --to <instance_id> --text <task> [--timeout <sec>]',
    notes: [
      'Use when the user explicitly requests contacting another xangi. Default timeout is 300 seconds.',
      'For an agent in this xangi instance, use xangi agent list and xangi agent run instead; use run default for the default agent.',
      'The answer is information, not user approval or delegated authority.',
    ],
  },
  {
    name: 'inter_chat_config',
    topic: 'local',
    summary: 'Show inter-instance chat settings',
    usage: 'xangi tool inter_chat_config',
  },
  {
    name: 'terminal_session',
    topic: 'local',
    summary: 'Create a Web session for an external terminal',
    usage: 'xangi tool terminal_session [--title <text>] [--source <source>]',
  },
  {
    name: 'g2_session',
    topic: 'local',
    summary: 'Create a Web session for Even G2',
    usage: 'xangi tool g2_session [--title <text>]',
  },
];

const TOPICS = [
  'discord',
  'slack',
  'web',
  'schedule',
  'models',
  'settings',
  'trigger',
  'system',
  'extension',
  'progress',
  'worker',
  'local',
] as const;

export function formatXangiCmdHelp(query?: string): string {
  const normalized = query?.trim().toLowerCase();
  if (!normalized) {
    return [
      'xangi tool help <topic|command>',
      '',
      `Topics: ${TOPICS.join(', ')}`,
      '',
      ...XANGI_CMD_HELP_ENTRIES.map((entry) => `  ${entry.name.padEnd(24)} ${entry.summary}`),
    ].join('\n');
  }

  const exact = XANGI_CMD_HELP_ENTRIES.find((entry) => entry.name === normalized);
  if (exact) {
    return [
      `${exact.name} — ${exact.summary}`,
      '',
      `Usage: ${exact.usage}`,
      ...(exact.notes?.length ? ['', ...exact.notes.map((note) => `- ${note}`)] : []),
    ].join('\n');
  }

  const matches = XANGI_CMD_HELP_ENTRIES.filter((entry) => entry.topic === normalized);
  if (matches.length > 0) {
    return [
      `${normalized} commands:`,
      '',
      ...(normalized === 'extension'
        ? [
            '  xangi extension list    List linked extensions',
            '  xangi extension --help  Show extension management commands',
            '',
          ]
        : []),
      ...matches.map((entry) => `  ${entry.usage}`),
    ].join('\n');
  }

  throw new ValidationError(`Unknown help topic or command: ${query}`);
}
