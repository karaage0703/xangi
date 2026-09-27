import { describe, it, expect, vi } from 'vitest';
import { ClaudeCodeRunner } from '../src/claude-code.js';
import { OpenCodeRunner } from '../src/opencode-cli.js';
import type { StreamCallbacks } from '../src/agent-runner.js';
class Claude extends ClaudeCodeRunner { parser(cb:StreamCallbacks) { return this.createStreamParser(cb); } }
class OpenCode extends OpenCodeRunner { parser(cb:StreamCallbacks) { return this.createStreamParser(cb); } }
describe('editor notification adapters',()=>{
  it('forwards Claude assistant tool arguments once without treating intent as success',()=>{
    const onToolUse=vi.fn(),onFileChanges=vi.fn(); const parser=new Claude({workdir:'/tmp'}).parser({onToolUse,onFileChanges});
    const event={type:'assistant',message:{content:[{type:'tool_use',id:'edit-1',name:'Edit',input:{file_path:'a',old_string:'a',new_string:'b'}}]}};
    parser.handleEvent(event,'stream'); parser.handleEvent(event,'stream');
    expect(onToolUse).toHaveBeenCalledTimes(1);expect(onToolUse).toHaveBeenCalledWith('Edit',event.message.content[0].input);
    expect(onFileChanges).not.toHaveBeenCalled();
  });
  it('reuses a successful OpenCode diff and never infers edits from missing or failed results',()=>{
    const onFileChanges=vi.fn();const parser=new OpenCode({workdir:'/tmp'}).parser({onFileChanges});
    for(const [id,status,diff] of [['1','completed','@@ -1 +1 @@\n-a\n+b'],['2','error','@@ -1 +1 @@\n-a\n+b'],['3','completed',undefined]]) {
      parser.handleEvent({type:'tool_use',part:{callID:id,tool:'edit',state:{status,input:{filePath:'a'},metadata:{diff}}}},'stream');
    }
    expect(onFileChanges).toHaveBeenCalledTimes(1);expect(onFileChanges).toHaveBeenCalledWith([{path:'a',operation:'modified',diff:'@@ -1 +1 @@\n-a\n+b'}]);
  });
});
