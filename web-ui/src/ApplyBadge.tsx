export function ApplyBadge({ mode }: { mode: 'immediate' | 'next-turn' | 'restart' }) {
  const label =
    mode === 'immediate' ? '即時反映' : mode === 'next-turn' ? '次のturnから' : '再起動後';
  return <span className={`settings-apply-badge ${mode}`}>{label}</span>;
}
