import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, symlink, unlink } from 'node:fs/promises';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileObservation, codexFileChanges, editedPaths, fileDiff } from '../src/file-changes.js';

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, openSync: vi.fn(actual.openSync), lstatSync: vi.fn(actual.lstatSync), realpathSync: vi.fn(actual.realpathSync), readdirSync: vi.fn(actual.readdirSync) };
});
const roots: string[] = [];
async function root() { const p = await mkdtemp(join(tmpdir(), 'file-changes-')); roots.push(p); return p; }
afterEach(async () => { vi.clearAllMocks(); await Promise.all(roots.splice(0).map(p => rm(p, {recursive:true,force:true}))); });

describe('targeted file observation', () => {
  it('performs zero filesystem observation for conversation, read and shell tools', () => {
    const observation = createFileObservation('/not-even-a-directory');
    observation.onToolUse('Read', {file_path: 'a'});
    observation.onToolUse('Bash', {command:'echo text > a'});
    expect(observation.finish()).toEqual({files: [], partial:false, concurrent:false});
    expect(fs.openSync).not.toHaveBeenCalled();
    expect(fs.realpathSync).not.toHaveBeenCalled();
    expect(fs.lstatSync).not.toHaveBeenCalled();
    expect(fs.readdirSync).not.toHaveBeenCalled();
  });
  it('reads only named targets and observes additions, edits, deletion and HTML', async () => {
    const dir = await root();
    await writeFile(join(dir, 'edit.ts'), 'keep\nold\nend\n');
    await writeFile(join(dir, 'delete.txt'), 'gone\n');
    await writeFile(join(dir, 'unrelated.txt'), 'do not read');
    const observation = createFileObservation(dir, 'workspace-2');
    observation.onToolUse('Edit', {file_path:'edit.ts'});
    observation.onToolUse('apply_patch', {patch:'*** Delete File: delete.txt\n*** Add File: index.html\n+hello'});
    await writeFile(join(dir, 'edit.ts'), 'keep\nnew\nend\n');
    await unlink(join(dir, 'delete.txt'));
    await writeFile(join(dir, 'index.html'), '<h1>hello</h1>');
    const report = observation.finish();
    expect(report.partial).toBe(false);
    expect(report.files.map(f=>[f.path,f.operation,f.workspaceId])).toEqual([
      ['edit.ts','modified','workspace-2'], ['delete.txt','deleted','workspace-2'], ['index.html','added','workspace-2']
    ]);
    expect(report.files[0]).toMatchObject({added:1,deleted:1});
    expect(report.files[0].diff).toContain('-old\n+new');
    expect(vi.mocked(fs.openSync).mock.calls.every(([path])=>!String(path).includes('unrelated'))).toBe(true);
    expect(fs.readdirSync).not.toHaveBeenCalled();
  });
  it('does not label a requested but failed or reverted edit as a change', async () => {
    const dir=await root(); await writeFile(join(dir,'a'),'old');
    const o=createFileObservation(dir); o.onToolUse('Edit',{file_path:'a'}); o.onToolUse('Write',{file_path:'missing'});
    await writeFile(join(dir,'a'),'intermediate'); await writeFile(join(dir,'a'),'old');
    expect(o.finish()).toMatchObject({files:[],partial:false});
  });
  it('does not infer pre-edit content from a late tool notification', async () => {
    const dir=await root(); await writeFile(join(dir,'a'),'already edited');
    const o=createFileObservation(dir); o.onToolUse('Edit',{file_path:'a'});
    expect(o.finish().files).toEqual([]);
  });
  it('uses successful native notifications even if no before-content was available', async () => {
    const dir=await root(); const o=createFileObservation(dir);
    o.onFileChanges(codexFileChanges({type:'file_change',status:'failed',changes:[{path:'fail',kind:'add'}]}));
    o.onFileChanges(codexFileChanges({type:'file_change',status:'completed',changes:[{path:'index.html',kind:'add'}]}));
    const result=o.finish();
    expect(result.files).toEqual([expect.objectContaining({path:'index.html',operation:'added',truncated:true,omittedReason:expect.stringContaining('比較用')})]);
    expect(fs.openSync).not.toHaveBeenCalled();
  });
  it('redacts and bounds native diffs and avoids combining separate patches into a fake net diff', async () => {
    const dir=await root(); const o=createFileObservation(dir);
    o.onFileChanges([{path:'a',operation:'modified',diff:'+token="privatevalue"\n'+'x'.repeat(9000)}]);
    o.onFileChanges([{path:'b',operation:'modified',diff:'+first'}]);
    o.onFileChanges([{path:'b',operation:'modified',diff:'+second'}]);
    const r=o.finish(); expect(r.files[0].diff?.length).toBeLessThanOrEqual(8000);
    expect(JSON.stringify(r)).not.toContain('privatevalue'); expect(r.files[1].diff).toBeUndefined();
  });
  it('rejects secrets, outside paths, internal trees and links, including links introduced after notification', async () => {
    const dir=await root(), outside=await root(); await writeFile(join(outside,'private'),'secret');
    await symlink(outside,join(dir,'link'));
    await mkdir(join(dir,'nested')); await writeFile(join(dir,'nested/a'),'old');
    const o=createFileObservation(dir);
    for(const path of ['.env','.git-credentials','nested/.git-credentials','credentials.json','nested/.state/a','../outside',join(outside,'private'),'link/private']) {
      o.onToolUse('Write',{file_path:path}); o.onFileChanges([{path,operation:'added',diff:'+secret'}]);
    }
    o.onToolUse('Edit',{file_path:'nested/a'});
    await rm(join(dir,'nested'),{recursive:true}); await symlink(outside,join(dir,'nested'));
    expect(o.finish().files).toEqual([]);
    expect(vi.mocked(fs.openSync).mock.calls.every(([p])=>String(p)===join(dir,'nested/a'))).toBe(true);
  });
  it('limits only observed files; a giant unrelated tree cannot cause partial warnings', async () => {
    const dir=await root(); await mkdir(join(dir,'tmp'));
    await writeFile(join(dir,'tmp/large'),'x'.repeat(200000));
    const o=createFileObservation(dir); o.onToolUse('Write',{file_path:'a'}); await writeFile(join(dir,'a'),'hello');
    expect(o.finish()).toMatchObject({partial:false,files:[{path:'a'}]});
  });
  it('reports unavailable target content without claiming an unconfirmed change', async () => {
    const dir=await root(); await writeFile(join(dir,'large'),'x'.repeat(140000));
    const o=createFileObservation(dir); o.onToolUse('Edit',{file_path:'large'});
    expect(o.finish()).toMatchObject({partial:true,files:[]});
    const confirmed=createFileObservation(dir); confirmed.onToolUse('Edit',{file_path:'large'});
    confirmed.onFileChanges([{path:'large',operation:'modified'}]);
    expect(confirmed.finish().files[0]).toMatchObject({truncated:true,omittedReason:expect.stringContaining('128 KiB')});
  });
  it('bounds target count and preserves no-op finish and closed lifecycle', async () => {
    const o=createFileObservation(await root());
    o.onToolUse('apply_patch',{edits:Array.from({length:120},(_,i)=>({path:`f${i}`}))});
    expect(o.finish()).toMatchObject({partial:true,files:[]});
    o.onToolUse('Write',{path:'late'}); expect(o.finish()).toMatchObject({partial:false,files:[]});
    expect(vi.mocked(fs.openSync).mock.calls.length).toBeLessThanOrEqual(200);
  });
  it('marks overlapping target files but not unrelated files and releases observers', async () => {
    const dir=await root(); const a=createFileObservation(dir), b=createFileObservation(dir), c=createFileObservation(dir);
    a.onToolUse('Write',{path:'shared'}); b.onToolUse('Write',{path:'shared'}); c.onToolUse('Write',{path:'other'});
    expect(a.finish().concurrent).toBe(true); expect(b.finish().concurrent).toBe(true); expect(c.finish().concurrent).toBe(false);
    const d=createFileObservation(dir); d.onToolUse('Write',{path:'shared'}); expect(d.finish().concurrent).toBe(false);
  });
  it('omits oversized native diffs before retaining them and combines add/update operations', async () => {
    const dir=await root(), o=createFileObservation(dir);
    o.onFileChanges([{path:'a',operation:'added',diff:'x'.repeat(140000)}]);
    const file=o.finish().files[0]; expect(file.diff).toBeUndefined(); expect(file.omittedReason).toContain('128 KiB');
    const n=createFileObservation(dir); n.onFileChanges([{path:'b',operation:'added'}]);n.onFileChanges([{path:'b',operation:'modified'}]);
    expect(n.finish().files[0].operation).toBe('added');
  });
  it.each([
    ['https://fixture-user:fixture-password@example.invalid/repo', ['fixture-user', 'fixture-password']],
    ['https://fixture-token@example.invalid/repo', ['fixture-token']],
    ['HTTPS://fixture%40user:fixture%3Apassword@example.invalid/repo', ['fixture%40user', 'fixture%3Apassword']],
    ['git+https://fixture-user:fixture@password@example.invalid/repo', ['fixture-user', 'fixture@password']],
  ])('redacts URL userinfo from both sides before generating a diff: %s', (url, secrets) => {
    const oldUrl = url.replaceAll('fixture', 'old-fixture');
    const result = fileDiff(`remote = "${oldUrl}"\nmode=old\n`, `remote = "${url}"\nmode=new\n`);
    expect(result.diff).toContain('***@example.invalid/repo');
    for (const secret of secrets) expect(result.diff).not.toContain(secret);
  });
  it('redacts multiple credential URLs in observed ordinary files without hiding public URLs', async () => {
    const dir = await root();
    const observation=createFileObservation(dir); observation.onToolUse('Write',{path:'remote-config.txt'});
    const publicUrl = 'https://example.invalid/path/contact@example.invalid?next=a@b#c@d';
    await writeFile(join(dir, 'remote-config.txt'), `https://fixture-one:fixture-two@example.invalid/repo\nhttps://fixture-three@example.invalid/other\n${publicUrl}\n`);
    const report = observation.finish();
    expect(report.files).toHaveLength(1);
    expect(JSON.stringify(report)).not.toContain('fixture-');
    expect(report.files[0].diff).toContain('https://***@example.invalid/repo');
    expect(report.files[0].diff).toContain('https://***@example.invalid/other');
    expect(report.files[0].diff).toContain(publicUrl);
  });
  it.each([
    'password: |\n  fixture-secret-one\n  fixture-secret-two\npublic: visible',
    'nested:\n  api_key: >-\n    fixture-secret-one\n    fixture-secret-two\n  public: visible',
    'password:\n  fixture-secret-one\n  fixture-secret-two\npublic: visible',
    'password: "fixture-secret-one\n  fixture-secret-two"\npublic: visible',
    "password: 'fixture-secret-one\n  fixture-secret-two'\npublic: visible",
    'AWS_SECRET_ACCESS_KEY=fixture-secret-one\nAWS_SESSION_TOKEN=fixture-secret-two\npublic: visible',
    '{"aws_secret_access_key":"fixture-secret-one","aws_access_key_id":"fixture-secret-two","public":"visible"}',
  ])('redacts complete multiline and provider-specific secret values: %s', (content) => {
    for (const [before, after] of [['', content], [content, ''], [content, content.replaceAll('fixture-secret', 'changed-secret')]]) {
      const diff = fileDiff(before, after).diff ?? '';
      expect(diff).not.toContain('secret-one');
      expect(diff).not.toContain('secret-two');
    }
    expect(fileDiff('', content).diff).toContain('visible');
  });
  it('redacts multiline secrets in backend-provided unified diffs', async () => {
    const o=createFileObservation(await root());
    o.onFileChanges([{path:'a.yaml',operation:'modified',diff:'@@ -1,2 +1,2 @@\n-password: |\n-  old-secret-value\n+password: |\n+  new-secret-value'}]);
    expect(JSON.stringify(o.finish())).not.toMatch(/old-secret-value|new-secret-value/);
  });
  it('normalizes patch paths without parsing shell text or dry-run edits', () => {
    expect(editedPaths('functions.apply_patch',{input:'*** Update File: a\n*** Move to: b\n*** Delete File: c'})).toEqual(['a','b','c']);
    expect(editedPaths('apply_patch',{dry_run:true,edits:[{path:'a'}]})).toEqual([]);
    expect(editedPaths('str_replace_editor',{command:'view',path:'a'})).toEqual([]);
  });
  it('normalizes app-server move notifications and rejects in-progress notifications', () => {
    expect(codexFileChanges({type:'fileChange',status:'completed',changes:[{path:'a',kind:{type:'update',move_path:'b'}}]})).toEqual([{path:'a',operation:'deleted'},{path:'b',operation:'added'}]);
    expect(codexFileChanges({type:'fileChange',status:'inProgress',changes:[{path:'a',kind:{type:'add'}}]})).toEqual([]);
  });
  it('counts separated edits, bounds diffs and detects final-newline-only edits', () => {
    expect(fileDiff('a\nkeep\nb\n','x\nkeep\ny\n')).toMatchObject({added:2,deleted:2,approximate:false});
    expect(fileDiff('','x'.repeat(9000)).truncated).toBe(true);
    expect(fileDiff('a','a\n').diff).toContain('No newline');
  });
  it('redacts credentials and private keys before truncation', () => {
    const r=fileDiff('', 'Authorization: "Bearer abc-secret"\npassword = "with spaces secret"\n-----BEGIN ' + 'PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----');
    expect(fileDiff('', 'AWS_SECRET_ACCESS_KEY=aws-private\npassword: |\n  yaml-private\n').diff).not.toMatch(/aws-private|yaml-private/);
    expect(r.diff).not.toContain('abc-secret'); expect(r.diff).not.toContain('with spaces secret'); expect(r.diff).not.toContain('private-material');
  });
});
