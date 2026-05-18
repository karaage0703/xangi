import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getAllTools,
  getActiveTools,
  getDeferredToolCatalog,
  loadAlwaysLoadedToolNames,
  toLLMTools,
  executeTool,
  registerDynamicTools,
} from '../src/local-llm/tools.js';
import type { ToolContext } from '../src/local-llm/types.js';

describe('loadAlwaysLoadedToolNames', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('未指定なら builtin core + tool_search を返す', () => {
    const env = {} as NodeJS.ProcessEnv;
    const names = loadAlwaysLoadedToolNames(env);
    expect(names.has('read')).toBe(true);
    expect(names.has('write')).toBe(true);
    expect(names.has('edit')).toBe(true);
    expect(names.has('exec')).toBe(true);
    expect(names.has('glob')).toBe(true);
    expect(names.has('grep')).toBe(true);
    expect(names.has('tool_search')).toBe(true);
  });

  it('LOCAL_LLM_ALWAYS_LOADED_TOOLS でカスタマイズできる', () => {
    const env = {
      LOCAL_LLM_ALWAYS_LOADED_TOOLS: 'read,grep',
    } as NodeJS.ProcessEnv;
    const names = loadAlwaysLoadedToolNames(env);
    expect(names.has('read')).toBe(true);
    expect(names.has('grep')).toBe(true);
    expect(names.has('write')).toBe(false);
    // tool_search は常に強制追加される
    expect(names.has('tool_search')).toBe(true);
  });

  it('カンマ区切りに空白が混じってもパースできる', () => {
    const env = {
      LOCAL_LLM_ALWAYS_LOADED_TOOLS: ' read , write , exec ',
    } as NodeJS.ProcessEnv;
    const names = loadAlwaysLoadedToolNames(env);
    expect(names.has('read')).toBe(true);
    expect(names.has('write')).toBe(true);
    expect(names.has('exec')).toBe(true);
  });
});

describe('getActiveTools / getDeferredToolCatalog', () => {
  beforeEach(() => {
    // 動的 tool をクリーン化（テスト分離）
    registerDynamicTools([]);
  });

  it('アクティブ名でフィルタした tool ハンドラを返す', () => {
    const active = new Set(['read', 'write']);
    const tools = getActiveTools(active);
    expect(tools.map((t) => t.name).sort()).toEqual(['read', 'write']);
  });

  it('アクティブ名に含まれない tool は deferred カタログに入る', () => {
    const active = new Set(['read']);
    const deferred = getDeferredToolCatalog(active);
    const deferredNames = deferred.map((d) => d.name);
    expect(deferredNames).toContain('write');
    expect(deferredNames).toContain('tool_search');
    expect(deferredNames).not.toContain('read');
  });

  it('カタログエントリには name と description のみ含む', () => {
    const active = new Set(['read']);
    const deferred = getDeferredToolCatalog(active);
    for (const entry of deferred) {
      expect(typeof entry.name).toBe('string');
      expect(typeof entry.description).toBe('string');
      expect(Object.keys(entry).sort()).toEqual(['description', 'name']);
    }
  });
});

describe('tool_search execute', () => {
  beforeEach(() => {
    registerDynamicTools([]);
  });

  it('query に対して関連 tool を検索し activateTools コールバックで通知', async () => {
    const activated: string[][] = [];
    const ctx: ToolContext = {
      workspace: '/tmp',
      activateTools: (names) => {
        activated.push(names);
      },
    };

    const result = await executeTool('tool_search', { query: 'read', limit: 5 }, ctx);
    expect(result.success).toBe(true);
    expect(activated.length).toBe(1);
    expect(activated[0]).toContain('read'); // name 完全一致は最高スコア
  });

  it('マッチなしなら success だが何も activate しない', async () => {
    const activated: string[][] = [];
    const ctx: ToolContext = {
      workspace: '/tmp',
      activateTools: (names) => {
        activated.push(names);
      },
    };
    const result = await executeTool('tool_search', { query: '__nonexistent_xyz__' }, ctx);
    expect(result.success).toBe(true);
    expect(activated.length).toBe(0);
    expect(result.output).toContain('No tools or skills matched');
    // 「同じ query で繰り返さず別アプローチ」ガイダンスが含まれる
    expect(result.output).toContain("don't call tool_search again with the same query");
  });

  it('limit でマッチ数を制限できる', async () => {
    const activated: string[][] = [];
    const ctx: ToolContext = {
      workspace: '/tmp',
      activateTools: (names) => {
        activated.push(names);
      },
    };
    // "tool" は description に多くのツールでマッチする
    const result = await executeTool('tool_search', { query: 'tool', limit: 2 }, ctx);
    expect(result.success).toBe(true);
    if (activated.length > 0) {
      expect(activated[0].length).toBeLessThanOrEqual(2);
    }
  });

  it('query が空なら error', async () => {
    const ctx: ToolContext = { workspace: '/tmp' };
    const result = await executeTool('tool_search', { query: '' }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('non-empty');
  });

  it('activateTools callback が無くても error にならない', async () => {
    const ctx: ToolContext = { workspace: '/tmp' };
    const result = await executeTool('tool_search', { query: 'read' }, ctx);
    expect(result.success).toBe(true);
  });
});

describe('tool_search が skills もマッチさせる (Step A)', () => {
  let tmpDir: string;

  beforeEach(() => {
    registerDynamicTools([]);
    const { mkdtempSync, mkdirSync, writeFileSync } = require('fs');
    const { join } = require('path');
    const { tmpdir } = require('os');
    tmpDir = mkdtempSync(join(tmpdir(), 'xangi-test-skills-'));
    // ダミー skill を 1 つ作成
    const arxivSkillDir = join(tmpDir, 'skills', 'arxiv');
    mkdirSync(arxivSkillDir, { recursive: true });
    writeFileSync(
      join(arxivSkillDir, 'SKILL.md'),
      `---\nname: arxiv\ndescription: arxiv論文を検索・取得して紹介するスキル\n---\n\n# arxiv skill\n`
    );
  });

  afterEach(() => {
    const { rmSync } = require('fs');
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skill 名にマッチすれば「Found N skill(s)」セクションを返す', async () => {
    const activated: string[][] = [];
    const ctx: ToolContext = {
      workspace: tmpDir,
      activateTools: (names) => activated.push(names),
    };

    const result = await executeTool('tool_search', { query: 'arxiv' }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('Found 1 skill(s)');
    expect(result.output).toContain('arxiv');
    expect(result.output).toContain('SKILL.md');
    expect(result.output).toContain('read'); // 「read で load しろ」ガイダンス
    // skill 自体は tool じゃないので activate されない
    expect(activated.length).toBe(0);
  });

  it('tool と skill が両方マッチすれば両方返す', async () => {
    const activated: string[][] = [];
    const ctx: ToolContext = {
      workspace: tmpDir,
      activateTools: (names) => activated.push(names),
    };
    // "search" は tool_search 名と arxiv skill description (検索) どちらにも近い
    const result = await executeTool('tool_search', { query: 'search' }, ctx);
    expect(result.success).toBe(true);
    // tool セクションは必ずあるはず (tool_search 自体が name 部分一致)
    expect(result.output).toContain('Activated');
  });
});

describe('tool_search が builtin に登録されている', () => {
  it('getAllTools に tool_search が含まれる', () => {
    const tools = getAllTools();
    expect(tools.some((t) => t.name === 'tool_search')).toBe(true);
  });

  it('toLLMTools で tool_search の schema が生成される', () => {
    const tools = getAllTools().filter((t) => t.name === 'tool_search');
    const llm = toLLMTools(tools);
    expect(llm.length).toBe(1);
    expect(llm[0].name).toBe('tool_search');
    expect(llm[0].parameters.required).toContain('query');
  });
});
