import { useCallback, useEffect, useMemo, useState } from 'react';
import { requestJson } from './api';

interface CommandChoice {
  name: string;
  value: string;
  description?: string;
}

interface CommandOption {
  name: string;
  description: string;
  type: 'subcommand' | 'string';
  required?: boolean;
  choices?: CommandChoice[];
  options?: CommandOption[];
}

interface CommandDefinition {
  name: string;
  description: string;
  usage: string;
  options?: CommandOption[];
}

interface PaletteOption {
  name: string;
  description?: string;
  hint?: string;
  usage: string;
}

function useCommandPalette(
  value: string,
  commands: CommandDefinition[]
): { title: string; options: PaletteOption[]; emptyText?: string; done?: boolean } {
  return useMemo(() => {
    if (!value.startsWith('/')) return { title: '', options: [], done: true };
    const trailingSpace = /\s$/.test(value);
    const parts = value.trim().split(/\s+/);
    const commandQuery = (parts.shift() || '').replace(/^\//, '').toLowerCase();
    const command = commands.find((candidate) => candidate.name.toLowerCase() === commandQuery);
    if (!command || (parts.length === 0 && !trailingSpace)) {
      return {
        title: 'コマンドを選択',
        options: commands
          .filter(
            (candidate) =>
              !commandQuery ||
              candidate.name.toLowerCase().includes(commandQuery) ||
              candidate.description.toLowerCase().includes(commandQuery)
          )
          .map((candidate) => ({
            name: `/${candidate.name}`,
            description: candidate.description,
            hint: candidate.usage,
            usage: `/${candidate.name} `,
          })),
      };
    }

    let prefix = `/${command.name}`;
    let options = command.options || [];
    const remaining = [...parts];
    while (options.length > 0) {
      const subcommands = options.filter((option) => option.type === 'subcommand');
      if (subcommands.length > 0) {
        const query = remaining[0] || '';
        const selected = subcommands.find(
          (option) => option.name.toLowerCase() === query.toLowerCase()
        );
        if (!selected || (remaining.length === 1 && !trailingSpace)) {
          return {
            title: `${command.name} の操作を選択`,
            options: subcommands
              .filter(
                (option) =>
                  !query ||
                  option.name.toLowerCase().includes(query.toLowerCase()) ||
                  option.description.toLowerCase().includes(query.toLowerCase())
              )
              .map((option) => ({
                name: option.name,
                description: option.description,
                hint: option.name,
                usage: `${prefix} ${option.name} `,
              })),
          };
        }
        prefix += ` ${selected.name}`;
        remaining.shift();
        options = selected.options || [];
        if (options.length === 0) return { title: '', options: [], done: true };
        continue;
      }
      const option = options[0];
      const query = remaining[0] || '';
      if (option.choices?.length) {
        const choice = option.choices.find(
          (candidate) => candidate.value.toLowerCase() === query.toLowerCase()
        );
        if (!choice || (remaining.length === 1 && !trailingSpace)) {
          return {
            title: option.description,
            options: option.choices
              .filter(
                (candidate) =>
                  !query ||
                  candidate.value.toLowerCase().includes(query.toLowerCase()) ||
                  candidate.name.toLowerCase().includes(query.toLowerCase())
              )
              .map((candidate) => ({
                name: candidate.name,
                description: candidate.description || option.description,
                hint: candidate.value,
                usage: `${prefix} ${candidate.value} `,
              })),
          };
        }
        prefix += ` ${choice.value}`;
        remaining.shift();
        options = options.slice(1);
        if (options.length === 0) return { title: '', options: [], done: true };
        continue;
      }
      if (!query) {
        return {
          title: option.description,
          options: [],
          emptyText: option.required
            ? `${option.description}を入力してください`
            : `必要なら${option.description}を入力。省略して送信できます`,
        };
      }
      return { title: '', options: [], done: true };
    }
    return { title: '', options: [], done: true };
  }, [commands, value]);
}

export function CommandPalette({
  sessionId,
  value,
  open,
  onChange,
  onClose,
  onExecute,
}: {
  sessionId: string | null;
  value: string;
  open: boolean;
  onChange: (value: string) => void;
  onClose: () => void;
  onExecute: (input: string) => Promise<void>;
}) {
  const [commands, setCommands] = useState<CommandDefinition[]>([]);
  const [active, setActive] = useState(0);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const state = useCommandPalette(value, commands);
  const selectedBackend = value.match(/^\/backend\s+set\s+([^\s]+)/i)?.[1] || '';
  const selectedModel = value.match(/(?:^|\s)--model=([^\s]+)/i)?.[1] || '';

  const runCommand = useCallback(async () => {
    if (running || !value.trim()) return;
    setRunning(true);
    setError('');
    try {
      await onExecute(value.trim());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
    }
  }, [onExecute, running, value]);

  useEffect(() => {
    if (!open) return;
    const params = new URLSearchParams();
    if (sessionId) params.set('appSessionId', sessionId);
    if (selectedBackend) params.set('backend', selectedBackend);
    if (selectedModel) params.set('model', selectedModel);
    requestJson<{ commands: CommandDefinition[] }>(`/api/web-commands?${params}`)
      .then((data) => setCommands(data.commands))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [open, selectedBackend, selectedModel, sessionId]);

  useEffect(() => setActive(0), [state.title, value]);
  useEffect(() => {
    if (!open) return;
    const handleKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (event.key === 'ArrowDown' && state.options.length) {
        event.preventDefault();
        setActive((current) => (current + 1) % state.options.length);
      } else if (event.key === 'ArrowUp' && state.options.length) {
        event.preventDefault();
        setActive((current) => (current - 1 + state.options.length) % state.options.length);
      } else if ((event.key === 'Tab' || event.key === 'Enter') && state.options[active]) {
        event.preventDefault();
        onChange(state.options[active].usage);
      } else if (event.key === 'Enter' && state.done && value.trim().length > 1) {
        event.preventDefault();
        void runCommand();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [active, onChange, onClose, open, runCommand, state.done, state.options, value]);
  if (!open) return null;

  return (
    <div className="command-popover">
      <div
        className="command-palette"
        role="listbox"
        aria-label={state.title || 'コマンド候補'}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
          if (event.key === 'ArrowDown' && state.options.length) {
            setActive((current) => (current + 1) % state.options.length);
          }
          if (event.key === 'ArrowUp' && state.options.length) {
            setActive((current) => (current - 1 + state.options.length) % state.options.length);
          }
        }}
      >
        <p>{state.title || 'コマンドを実行'}</p>
        {state.options.map((option, index) => (
          <button
            type="button"
            role="option"
            aria-selected={index === active}
            className={index === active ? 'command-option active' : 'command-option'}
            key={`${option.usage}-${index}`}
            onMouseEnter={() => setActive(index)}
            onClick={() => onChange(option.usage)}
          >
            <span>{option.name}</span>
            <small>{option.description}</small>
            <code>{option.hint}</code>
          </button>
        ))}
        {state.options.length === 0 && !state.done && (
          <div className="command-empty">{state.emptyText || '一致する候補がありません'}</div>
        )}
        {state.done && value.trim().length > 1 && (
          <button type="button" className="command-run" disabled={running} onClick={runCommand}>
            {running ? '実行中…' : `${value.trim()} を実行`}
          </button>
        )}
      </div>
      {error && <div className="command-error">{error}</div>}
    </div>
  );
}
