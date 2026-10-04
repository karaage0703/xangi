/** Read old saved state only; commands and API inputs accept Team names exclusively. */
export function migrateTeamId(id: string): string {
  return id.startsWith('party:') ? `team:${id.slice('party:'.length)}` : id;
}

/** JSON reviver for catalog, session snapshots and run metadata, never user prose. */
export function migrateTeamState(key: string, value: unknown): unknown {
  if (typeof value === 'string' && ['id', 'agentId', 'selectedAgentId'].includes(key))
    return migrateTeamId(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  for (const [legacy, current] of [
    ['parties', 'teams'],
    ['party', 'team'],
    ['partyId', 'teamId'],
    ['partyTurnId', 'teamTurnId'],
    ['partyPhase', 'teamPhase'],
  ]) {
    if (!Object.hasOwn(record, legacy)) continue;
    if (!Object.hasOwn(record, current)) record[current] = record[legacy];
    delete record[legacy];
  }
  return record;
}
