import { useId, useState } from 'react';
import { AgentAvatar } from './AgentAvatar';
import { agentSettingsPath } from './AgentPet';
import { NavigationIcon } from './AppNavigation';

export function SidebarAgents({
  agents,
  activeId,
  onSelect,
  onBrowse,
}: {
  agents: { id: string; name: string; avatarUrl?: string; petPortraitUrl?: string }[];
  activeId: string;
  onSelect: (id: string) => void;
  onBrowse: () => void;
}) {
  const listId = useId();
  const [expanded, setExpanded] = useState(true);
  const visible = agents.filter((agent, index) => index < 5 || agent.id === activeId);

  return (
    <section className="sidebar-agents" aria-label="エージェント一覧">
      <div className="sidebar-section-heading">
        <h2>
          <button
            type="button"
            className="sidebar-agent-toggle"
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={() => setExpanded(!expanded)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d={expanded ? 'm6 9 6 6 6-6' : 'm9 6 6 6-6 6'} />
            </svg>
            エージェント
          </button>
        </h2>
        <a className="sidebar-agent-settings" href="/settings#agents" aria-label="エージェント設定">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <NavigationIcon icon="settings" />
          </svg>
        </a>
      </div>
      <div id={listId} hidden={!expanded}>
        {visible.map((agent) => (
          <div className="sidebar-agent-row" key={agent.id}>
            <button
              type="button"
              className="sidebar-agent-select"
              aria-pressed={activeId === agent.id}
              title={agent.name}
              onClick={() => onSelect(agent.id)}
            >
              <AgentAvatar
                name={agent.name}
                url={agent.avatarUrl}
                petPortraitUrl={agent.petPortraitUrl}
              />
              <span className="sidebar-agent-name">{agent.name}</span>
            </button>
            <a
              className="sidebar-agent-settings"
              href={agentSettingsPath(agent.id)}
              aria-label={`${agent.name}の設定`}
              title={`${agent.name}の設定`}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <NavigationIcon icon="settings" />
              </svg>
            </a>
          </div>
        ))}
        {agents.length > visible.length && (
          <button type="button" className="sidebar-agent-more" onClick={onBrowse}>
            すべて表示（{agents.length}）
          </button>
        )}
      </div>
    </section>
  );
}
