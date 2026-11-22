import { useId, useState, type ReactNode } from 'react';

const COLLAPSED_KEY = 'xangi.chat.projectsCollapsed';

interface SidebarProject {
  id: string;
  name: string;
}

export function SidebarProjects({
  projects,
  activeId,
  agentActive,
  agents,
  lifecycleFilter,
  onLifecycleFilterChange,
  onSelect,
  onCreate,
  onEdit,
}: {
  projects: SidebarProject[];
  activeId: string;
  agentActive?: boolean;
  agents?: ReactNode;
  lifecycleFilter: 'all' | 'open' | 'closed';
  onLifecycleFilterChange: (value: 'all' | 'open' | 'closed') => void;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onEdit: (id: string) => void;
}) {
  const listId = useId();
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(COLLAPSED_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const [expanded, setExpanded] = useState(false);
  const visible = expanded
    ? projects
    : projects.filter((project, index) => index < 5 || project.id === activeId);

  return (
    <nav className="sidebar-projects" aria-label="プロジェクト一覧">
      <button
        type="button"
        className="sidebar-all-chats"
        aria-pressed={!activeId && !agentActive}
        onClick={() => onSelect('')}
      >
        すべての会話
      </button>
      <label className="sidebar-lifecycle-filter">
        <span>会話の状態</span>
        <select
          value={lifecycleFilter}
          onChange={(event) =>
            onLifecycleFilterChange(event.target.value as 'all' | 'open' | 'closed')
          }
        >
          <option value="all">すべて</option>
          <option value="open">未完了</option>
          <option value="closed">完了</option>
        </select>
      </label>
      {agents}
      <div className="sidebar-section-heading">
        <h2>
          <button
            type="button"
            className="sidebar-project-toggle"
            aria-expanded={!collapsed}
            aria-controls={listId}
            title={collapsed ? 'プロジェクト一覧を開く' : 'プロジェクト一覧を閉じる'}
            onClick={() => {
              const next = !collapsed;
              setCollapsed(next);
              try {
                window.localStorage.setItem(COLLAPSED_KEY, String(next));
              } catch {
                // Keep the toggle usable when browser storage is unavailable.
              }
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d={collapsed ? 'm9 6 6 6-6 6' : 'm6 9 6 6 6-6'} />
            </svg>
            プロジェクト
          </button>
        </h2>
        <button
          type="button"
          aria-label="新規プロジェクト"
          title="新規プロジェクト"
          onClick={onCreate}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>
      <div id={listId} hidden={collapsed}>
        {visible.map((project) => (
          <div className="sidebar-project-row" key={project.id}>
            <button
              type="button"
              className="sidebar-project-select"
              aria-pressed={activeId === project.id}
              title={project.name}
              onClick={() => onSelect(project.id)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 6h6l2 2h8v11H4Z" />
              </svg>
              <span>{project.name}</span>
            </button>
            <div className="sidebar-project-actions">
              <button
                type="button"
                aria-label={`${project.name}の設定`}
                title="プロジェクト設定"
                onClick={() => onEdit(project.id)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="5" cy="12" r="1" />
                  <circle cx="12" cy="12" r="1" />
                  <circle cx="19" cy="12" r="1" />
                </svg>
              </button>
            </div>
          </div>
        ))}
        {projects.length === 0 && (
          <p className="sidebar-project-empty">プロジェクトはまだありません</p>
        )}
        {projects.length > 5 && (
          <button
            className="sidebar-project-more"
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? '表示を減らす' : `すべて表示（${projects.length}）`}
          </button>
        )}
      </div>
    </nav>
  );
}
