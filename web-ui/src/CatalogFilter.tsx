export function CatalogFilter({
  editing,
  agentMode,
  query,
  onChange,
}: {
  editing: boolean;
  agentMode: boolean;
  query: string;
  onChange: (value: string) => void;
}) {
  if (editing) return null;
  return (
    <div className="catalog-filter">
      <label>
        <span>{agentMode ? 'エージェントを検索' : 'プロジェクトを検索'}</span>
        <input type="search" value={query} onChange={(event) => onChange(event.target.value)} />
      </label>
    </div>
  );
}
