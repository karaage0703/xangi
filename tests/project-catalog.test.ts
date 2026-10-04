import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectCatalog } from '../src/project-catalog.js';

describe('shared projects and agents', () => {
  const roots: string[] = [];
  const root = () => {
    const p = mkdtempSync(join(tmpdir(), 'catalog-'));
    roots.push(p);
    return p;
  };
  afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
  it('retires old fields into editable instructions once and drops them from new saves', () => {
    const dir = root();
    const catalog = new ProjectCatalog(dir);
    const agent = catalog.saveAgent({ name: 'Writer', prompt: 'individual' });
    const project = catalog.create({
      name: 'Talk',
      prompt: 'shared',
      agentIds: [agent.id],
      defaultAgentId: agent.id,
    });
    const file = join(dir, 'project-catalog.json');
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    raw.agents[0].expertise = 'slides';
    raw.projects[0].goal = 'teach';
    raw.projects[0].materials = 'reference';
    writeFileSync(file, JSON.stringify(raw));
    let loaded = new ProjectCatalog(dir);
    expect(loaded.agent(agent.id)?.prompt).toBe('slides\n\nindividual');
    expect(loaded.get(project.id)?.prompt).toBe('reference\n\nteach\n\nshared');
    expect(loaded.agent(agent.id)).not.toHaveProperty('expertise');
    expect(loaded.get(project.id)).not.toHaveProperty('goal');
    expect(loaded.get(project.id)).not.toHaveProperty('materials');
    const migrated = readFileSync(file, 'utf8');
    loaded = new ProjectCatalog(dir);
    expect(readFileSync(file, 'utf8')).toBe(migrated);
    expect(loaded.execution(project.id)?.prompt).toContain('reference\n\nteach\n\nshared');
    expect(loaded.saveAgent({ name: 'New', expertise: 'ignored' })).not.toHaveProperty('expertise');
    expect(loaded.create({ name: 'New', goal: 'ignored' })).not.toHaveProperty('goal');
  });
  it('selects any agent independently of projects and keeps child instructions separate', () => {
    const catalog = new ProjectCatalog(root());
    const a = catalog.saveAgent({ name: 'Writer', role: 'write', prompt: 'individual' });
    const p = catalog.create({ name: 'Team', prompt: 'shared' });
    expect(catalog.execution(p.id)?.prompt).toBe('shared');
    expect(catalog.execution(p.id, a.id)?.prompt).toBe('shared\n\nwrite\n\nindividual');
    expect(catalog.execution(undefined, a.id)?.prompt).toBe('write\n\nindividual');
    expect(catalog.get(p.id)).not.toHaveProperty('agentIds');
    expect(catalog.get(p.id)).not.toHaveProperty('defaultAgentId');
    expect(() => catalog.execution(p.id, 'missing')).toThrow('見つかりません');
    catalog.removeAgent(a.id);
    expect(catalog.get(p.id)?.prompt).toBe('shared');
  });

  it.each([false, true])(
    'migrates without leaking project prompts (previous catalog: %s)',
    (previousCatalog) => {
      const dir = root();
      const legacy = JSON.stringify({
        version: 1,
        projects: [
          {
            id: 'old',
            name: 'Reviewer',
            prompt: 'review carefully',
            backend: 'codex',
            model: 'test-model',
            workspaceId: 'work',
            createdAt: 'then',
            updatedAt: 'now',
          },
        ],
      });
      writeFileSync(join(dir, 'web-projects.json'), legacy);
      if (previousCatalog) {
        const old = JSON.parse(legacy).projects[0];
        writeFileSync(
          join(dir, 'project-catalog.json'),
          JSON.stringify({
            version: 1,
            agents: [{ ...old, role: '', expertise: '' }],
            projects: [
              {
                ...old,
                backend: undefined,
                model: undefined,
                prompt: '',
                goal: '',
                materials: '',
                agentIds: [old.id],
                defaultAgentId: old.id,
              },
            ],
          })
        );
      }
      let catalog = new ProjectCatalog(dir);
      expect(catalog.get('old')).toMatchObject({
        id: 'old',
        prompt: 'review carefully',
        workspaceId: 'work',
      });
      expect(catalog.agent('old')).toMatchObject({ prompt: '', model: 'test-model' });
      expect(catalog.execution('old', 'old')).toMatchObject({
        prompt: expect.stringContaining('review carefully'),
        model: 'test-model',
      });
      const other = catalog.create({ name: 'Unrelated', agentIds: ['old'], defaultAgentId: 'old' });
      expect(catalog.execution(other.id)?.prompt).not.toContain('review carefully');
      catalog.update('old', { prompt: 'new instructions' });
      catalog = new ProjectCatalog(dir);
      expect(catalog.agents()).toHaveLength(1);
      expect(catalog.get('old')?.prompt).toBe('new instructions');
      expect(readFileSync(join(dir, 'web-projects.json'), 'utf8')).toBe(legacy);
    }
  );
  it('reuses an agent in two projects without sharing project-specific context', () => {
    const catalog = new ProjectCatalog(root());
    const a = catalog.saveAgent({
      name: 'Writer',
      role: 'write',
      prompt: 'short sentences',
      backend: 'codex',
    });
    const b = catalog.saveAgent({ name: 'Reviewer', prompt: 'review only' });
    const p = catalog.create({
      name: 'Talk',
      prompt: 'Japanese talk source',
      agentIds: [a.id, b.id],
      defaultAgentId: a.id,
    });
    const q = catalog.create({
      name: 'Book',
      prompt: 'book only',
      agentIds: [a.id],
      defaultAgentId: a.id,
    });
    expect(catalog.execution(p.id)?.prompt).toContain('talk source');
    expect(catalog.execution(p.id)?.prompt).not.toContain('review only');
    expect(catalog.execution(q.id)?.prompt).not.toContain('talk source');
    catalog.saveAgent({ prompt: 'updated' }, a.id);
    expect(catalog.execution(p.id, a.id)?.prompt).toContain('updated');
    expect(catalog.execution(q.id, a.id)?.prompt).toContain('updated');
    expect(catalog.execution(q.id, b.id)?.prompt).toBe('book only\n\nreview only');
    catalog.removeAgent(a.id);
    expect(catalog.agent(a.id)).toBeUndefined();
  });
  it('imports Studio projects idempotently without merging equal names', () => {
    const dir = root();
    let catalog = new ProjectCatalog(dir);
    const original = catalog.create({ name: 'Talk' });
    const imported = catalog.importStudio({ legacyId: 'studio-old', name: 'talk' });
    expect(imported.id).not.toBe(original.id);
    catalog = new ProjectCatalog(dir);
    expect(catalog.importStudio({ legacyId: 'studio-old', name: 'Talk' }).id).toBe(imported.id);
    expect(catalog.list()).toHaveLength(2);
  });
  it('persists agent workspace and Local LLM settings across reload and ignores project workspace', () => {
    const dir = root();
    const catalog = new ProjectCatalog(dir);
    const a = catalog.saveAgent({
      name: 'Chat agent',
      backend: 'local-llm',
      workspaceId: 'child',
      localLlmMode: 'chat',
      localLlmReasoningEffort: 'low',
    });
    const p = catalog.create({
      name: 'Shared',
      workspaceId: 'parent',
      agentIds: [a.id],
      defaultAgentId: a.id,
    });
    const reloaded = new ProjectCatalog(dir);
    for (const projectId of [p.id, undefined]) {
      expect(reloaded.execution(projectId, a.id)).toMatchObject({
        workspaceId: 'child',
        localLlmMode: 'chat',
        localLlmReasoningEffort: 'low',
      });
    }
    const before = readFileSync(join(dir, 'project-catalog.json'), 'utf8');
    for (const invalid of [
      { localLlmMode: 'bad' },
      { localLlmReasoningEffort: 'bad' },
      { workspaceId: 42 },
      { backend: 'codex' },
    ]) {
      expect(() => reloaded.saveAgent(invalid, a.id)).toThrow();
      expect(readFileSync(join(dir, 'project-catalog.json'), 'utf8')).toBe(before);
    }
    reloaded.saveAgent(
      { backend: 'codex', localLlmMode: null, localLlmReasoningEffort: null },
      a.id
    );
    expect(reloaded.agent(a.id)?.localLlmMode).toBeUndefined();
  });
});

it('merges legacy Agent roles once and migrates named hierarchy members without dropping instructions',()=>{
 const dir=mkdtempSync(join(tmpdir(),'simplify-team-'));
 try {
  const c=new ProjectCatalog(dir);
  const a=c.saveAgent({name:'Lead',prompt:'standing instructions'});
  const b=c.saveAgent({name:'Member',prompt:'member instructions'});
  const t=c.saveTeam({name:'Team',members:[{agentId:a.id},{agentId:b.id,role:'review'}]});
  const file=join(dir,'project-catalog.json');const raw=JSON.parse(readFileSync(file,'utf8'));
  raw.agents[0].role='specialty';raw.teams[0].members[0].role='specialty';raw.teams[0].leadership='fixed';raw.teams[0].members[1].reportsTo=a.id;
  writeFileSync(file,JSON.stringify(raw));
  const migrated=new ProjectCatalog(dir);
  expect(migrated.agent(a.id)?.prompt).toBe('specialty\n\nstanding instructions');
  expect(migrated.agent(a.id)).not.toHaveProperty('role');
  expect(migrated.team(t.id)).toMatchObject({leadership:'caller',members:[{agentId:a.id,role:''},{agentId:b.id,role:'review'}]});
  expect(migrated.team(t.id)?.members.some(m=>m.reportsTo)).toBe(false);
  const saved=readFileSync(file,'utf8');new ProjectCatalog(dir);expect(readFileSync(file,'utf8')).toBe(saved);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
