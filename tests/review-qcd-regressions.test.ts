import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SecretStore } from '../src/setup/secret-store.js';
import { WorkspaceBrowser } from '../src/workspace-browser.js';
import { WorkspaceRegistry } from '../src/workspace-registry.js';
import { workspaceTargetFromHref } from '../web-ui/src/workspace-navigation.js';
import { cronDescription, timingForm } from '../web-ui/src/Schedules.js';
import { readJsonObjectBody } from '../src/web-http.js';
import { updateEnvKeyValue, updateEnvKeyValues } from '../src/env-persist.js';
import { validateChannelOverrides } from '../src/config-validate.js';
import { loadSetupRuntimeEnv } from '../src/installer/runtime-config.js';
import { managedEnvPath } from '../src/installer/managed-env.js';
import { executeTool } from '../src/local-llm/tools.js';
import { resolveAppLayout } from '../src/installer/layout.js';
import { assertManagedDeletionPreservesWorkspaces, assertWorkspaceOutsideManagedDirectories } from '../src/installer/workspace-protection.js';
import { isIdempotentToolCall } from '../src/local-llm/runner.js';
import type { Schedule } from '../web-ui/src/types.js';

const roots: string[] = [];
async function fixture() { const root=await mkdtemp(join(tmpdir(),'xangi-review-regression-')); roots.push(root); return root; }
afterEach(async () => { vi.unstubAllEnvs(); vi.useRealTimers(); await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true}))); });

describe('review regression cases', () => {
  it.each(['/chat/abc#message-1','/chat/abc?x=1','/settings/','/extensions?tab=all'])('R01 preserves app navigation %s', href => {
    expect(workspaceTargetFromHref(href)).toBeUndefined();
  });
  it.each(['*/5 9 * * *','0 9-17 * * *','0 9,10 * * *','60 9 * * *','0 24 * * *'])('R23 preserves complex or invalid fixed-time expression %s', expression => {
    expect(cronDescription(expression)).toBe(expression);
    expect(timingForm({type:'cron',expression} as Schedule)).toMatchObject({mode:'cron',expression});
  });
  it('R23 still recognizes daily and weekly fixed times', () => {
    expect(timingForm({type:'cron',expression:'5 9 * * *'} as Schedule)).toMatchObject({mode:'daily',time:'09:05'});
    expect(timingForm({type:'cron',expression:'5 9 * * 1'} as Schedule)).toMatchObject({mode:'weekly',time:'09:05',weekday:'1'});
  });
  it('R16 serializes writes across browser instances and symlink aliases', async () => {
    const root=await fixture(); const alias=root+'-alias'; roots.push(alias);
    await symlink(root,alias,'dir'); await writeFile(join(root,'file.txt'),'before');
    const a=new WorkspaceBrowser(root), b=new WorkspaceBrowser(alias);
    const opened=await a.read('file.txt');
    const results=await Promise.allSettled([a.write('file.txt','first',opened.version),b.write('file.txt','second',opened.version)]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(results.filter(r=>r.status==='rejected')).toMatchObject([{reason:{status:409}}]);
    expect(['first','second']).toContain(await readFile(join(root,'file.txt'),'utf8'));
  });
  it('R17 decodes split HTTP JSON at every UTF-8 boundary', async () => {
    const payload=Buffer.from(JSON.stringify({text:'日本語🙂'}));
    for(let i=1;i<payload.length;i++) {
      const req=Readable.from([payload.subarray(0,i),payload.subarray(i)]) as IncomingMessage;
      await expect(readJsonObjectBody(req,100)).resolves.toEqual({text:'日本語🙂'});
    }
  });
  it('R25 accepts OpenCode channel overrides at startup', () => {
    const result=validateChannelOverrides(JSON.stringify({'123456789012345678':{backend:'opencode',model:'test'}}));
    expect(result.issues).toEqual([]);
    expect(result.overrides?.['123456789012345678']).toMatchObject({backend:'opencode'});
  });
  it('R29 resumes an existing snapshot when only the new registered location disappears', async () => {
    const root=await fixture(); const old=join(root,'old'), next=join(root,'next');
    await mkdir(old); await mkdir(next);
    const registry=await WorkspaceRegistry.open({dataDir:join(root,'state'),defaultWorkspacePath:root});
    const workspace=await registry.register('work',old); await registry.updatePath(workspace.id,next); await rm(next,{recursive:true});
    await expect(registry.resolveSnapshot(workspace.id,old)).resolves.toMatchObject({path:old});
    await rm(old,{recursive:true}); await expect(registry.resolveSnapshot(workspace.id,old)).rejects.toThrow(/Saved workspace/);
  });
  it('R30 preserves a saved global backend and clears the old setup model', async () => {
    const root=await fixture(); const config=join(root,'xangi.json');
    await writeFile(config,JSON.stringify({backend:'claude-code',model:'old-model',workspacePath:root,webChatEnabled:true}));
    await writeFile(managedEnvPath(config),'AGENT_BACKEND=codex\nAGENT_EFFORT=high\nXANGI_GLOBAL_BACKEND_OVERRIDE=true\n');
    const env=await loadSetupRuntimeEnv(config,join(root,'state'));
    expect(env).toMatchObject({AGENT_BACKEND:'codex',AGENT_MODEL:'',AGENT_EFFORT:'high'});
  });
  it('R33 retains concurrent secret updates across separate stores', async () => {
    const root=await fixture(); const file=join(root,'secrets.json');
    await Promise.all(Array.from({length:8},(_,i)=>new SecretStore(file).set('TEST_'+i,'synthetic-'+i)));
    expect(Object.keys(await new SecretStore(file).all())).toHaveLength(8);
  });
  it('R36 persists literal replacement metacharacters through both env writers', async () => {
    const root=await fixture(); const file=join(root,'runtime.env'); vi.stubEnv('XANGI_ENV_PATH',file);
    await writeFile(file,'URL=before\n');
    const value="https://example.test/$&/$`/$'/$$";
    expect(updateEnvKeyValue('URL',value).ok).toBe(true);
    expect(await readFile(file,'utf8')).toBe('URL='+value+'\n');
    expect(updateEnvKeyValues({URL:value+'?next'}).ok).toBe(true);
    expect(await readFile(file,'utf8')).toBe('URL='+value+'?next\n');
  });
  it('R38 rejects state descendants whose names start with two dots', async () => {
    const root=await fixture(); const state=join(root,'state'); await mkdir(join(state,'..hidden'),{recursive:true});
    const registry=await WorkspaceRegistry.open({dataDir:state,defaultWorkspacePath:root});
    await expect(registry.register('hidden',join(state,'..hidden'))).rejects.toThrow(/DATA_DIR/);
    const sibling=join(root,'..outside');await mkdir(sibling);await expect(registry.register('outside',sibling)).resolves.toMatchObject({path:sibling});
  });
  it.each(['wc -c file.txt','sha256sum file.txt','base64 file.txt','python -c "import hashlib; open(\'file.txt\')"'])('R41 reruns state-dependent commands: %s', command => {
    expect(isIdempotentToolCall('exec',{command})).toBe(false);
  });
  it('R09 cancellation stops descendants before they can write', async () => {
    if(process.platform==='win32')return;
    const root=await fixture(); const marker=join(root,'should-not-exist');const ready=join(root,'ready');
    const controller=new AbortController();
    const command=`node -e "require('fs').writeFileSync('ready','ready');setTimeout(()=>require('fs').writeFileSync('should-not-exist','bad'),400)"`;
    const pending=executeTool('exec',{command},{workspace:root,signal:controller.signal});
    await vi.waitFor(async()=>{expect(await readFile(ready,'utf8')).toBe('ready');});
    const cancelled = expect(pending).rejects.toThrow(/abort/i);
    controller.abort(); await cancelled;
    await new Promise(resolve=>setTimeout(resolve,500));await expect(readFile(marker)).rejects.toThrow();
  });
  it.each(['app','config','state'])('R06 refuses deleting a workspace under managed %s before uninstall', async kind => {
    const root=await fixture();const layout=resolveAppLayout({platform:'linux',arch:'x64',homeDir:root});
    const target=kind==='app'?layout.appRoot:kind==='config'?layout.configDir:layout.stateDir;
    const workspace=join(target,'my-work'); await mkdir(workspace,{recursive:true}); await mkdir(layout.configDir,{recursive:true});
    await writeFile(layout.configFile,JSON.stringify({workspacePath:workspace}));
    await expect(assertManagedDeletionPreservesWorkspaces(layout,true)).rejects.toThrow(/would delete a workspace/);
    await expect(assertWorkspaceOutsideManagedDirectories(workspace,layout)).rejects.toThrow(/outside managed/);
  });
  it('R06 also protects symlinked workspaces and historical session snapshots', async () => {
    const root=await fixture();const layout=resolveAppLayout({platform:'linux',arch:'x64',homeDir:root});
    const inside=join(layout.configDir,'historical');await mkdir(inside,{recursive:true});await mkdir(layout.stateDir,{recursive:true});
    const alias=join(root,'alias');await symlink(inside,alias,'dir');
    await writeFile(join(layout.stateDir,'sessions.json'),JSON.stringify({sessions:{old:{workspacePath:alias}}}));
    await expect(assertManagedDeletionPreservesWorkspaces(layout,true)).rejects.toThrow(/would delete a workspace/);
  });

  it('R20 executes all consecutive expired once jobs during startup', async () => {
    const {Scheduler}=await import('../src/scheduler.js');const root=await fixture();
    const schedules=Array.from({length:3},(_,i)=>({id:'past-'+i,type:'once',runAt:new Date(Date.now()-1000).toISOString(),message:'test',channelId:'test-'+i,platform:'web',createdAt:new Date().toISOString(),enabled:true}));
    await writeFile(join(root,'schedules.json'),JSON.stringify(schedules));
    const scheduler=new Scheduler(root,{quiet:true});const run=vi.fn(async()=> 'ok');scheduler.registerAgentRunner('web',run);
    try{scheduler.startAll();await vi.waitFor(()=>expect(run).toHaveBeenCalledTimes(3));}finally{scheduler.stopAll();}
  });
  it('R26 retains a 30-day once schedule until its actual deadline', async () => {
    const {Scheduler}=await import('../src/scheduler.js');const root=await fixture();vi.useFakeTimers();
    const scheduler=new Scheduler(root,{quiet:true});const run=vi.fn(async()=> 'ok');scheduler.registerAgentRunner('web',run);
    try {
      const job=scheduler.add({type:'once',runAt:new Date(Date.now()+30*86400000).toISOString(),message:'test',channelId:'test',platform:'web'});
      await vi.advanceTimersByTimeAsync(2_147_483_647);expect(run).not.toHaveBeenCalled();expect(scheduler.list().map(s=>s.id)).toContain(job.id);
      await vi.advanceTimersByTimeAsync(30*86400000-2_147_483_647);expect(run).toHaveBeenCalledTimes(1);expect(scheduler.list().map(s=>s.id)).not.toContain(job.id);
    } finally{scheduler.stopAll();}
  });
  it('R32 mounts GPU CLI authentication under the image user home', async () => {
    const {parse}=await import('yaml');const compose=parse(await readFile(new URL('../docker-compose.yml',import.meta.url),'utf8'));
    const volumes=compose.services['xangi-gpu'].volumes as string[];
    expect(volumes).toContain('claude-data:/home/ubuntu/.claude');expect(volumes).toContain('codex-data:/home/ubuntu/.codex');
    expect(volumes.some(v=>v.includes('/home/node/'))).toBe(false);
    expect(await readFile(new URL('../docker/Dockerfile.gpu',import.meta.url),'utf8')).toMatch(/USER ubuntu/);
  });

});
