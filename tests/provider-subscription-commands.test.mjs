import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { providerCommand } from '../dist/providers/commands.js';
import { buildProviderConfig } from '../dist/providers/setup.js';
import { runProviderSetupWizard } from '../dist/ui/setup.js';
import { ProviderRegistry } from '../dist/providers/registry.js';
import { executeTuiCommand, parseTuiCommand } from '../dist/tui/commands.js';
import { initialState } from '../dist/tui/state.js';

async function fixture(t) {
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'hive-subscription-command-')), root=path.join(temporary,'project'), home=path.join(temporary,'auth'), globalRoot=path.join(temporary,'global'), marker=path.join(temporary,'signed-in'), log=path.join(temporary,'rpc.jsonl'), script=path.join(temporary,'codex-fixture.mjs');
  await fs.mkdir(root); await fs.mkdir(globalRoot);
  await fs.writeFile(script, `import readline from 'node:readline';import fs from 'node:fs';const [marker,log]=process.argv.slice(2);const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(log,JSON.stringify({method:m.method,params:m.params})+'\\n');if(m.id===undefined)return;const reply=result=>send({id:m.id,result});switch(m.method){case'initialize':reply({userAgent:'fixture'});break;case'account/read':reply({account:fs.existsSync(marker)?{type:'chatgpt',email:'PRIVATE_ACCOUNT_EMAIL',planType:'plus'}:null,requiresOpenaiAuth:true});break;case'account/login/start':fs.writeFileSync(marker,'signed in');reply(m.params.type==='chatgptDeviceCode'?{type:'chatgptDeviceCode',loginId:'fixture-login',verificationUrl:'https://auth.openai.com/codex/device',userCode:'TEST-CODE'}:{type:'chatgpt',loginId:'fixture-login',authUrl:'https://auth.openai.com/authorize?state=fixture'});send({method:'account/login/completed',params:{loginId:'fixture-login',success:true,error:null}});break;case'account/login/cancel':reply({status:'cancelled'});break;case'account/logout':fs.rmSync(marker,{force:true});reply({});break;case'model/list':reply({data:[{id:'selected-model',model:'selected-model',displayName:'Selected model',supportedReasoningEfforts:[{reasoningEffort:'high'}],serviceTiers:[]}],nextCursor:null});break;default:send({id:m.id,error:{code:-32601,message:'Not supported'}})}});`);
  const options={globalRoot,chatgptOptions:{executable:process.execPath,args:[script,marker,log],homeDir:home,requestTimeoutMs:2000}}, registry=new ProviderRegistry(root);
  t.after(async()=>{assert.equal(path.dirname(temporary),path.resolve(os.tmpdir()));assert.ok(path.basename(temporary).startsWith('hive-subscription-command-'));await fs.rm(temporary,{recursive:true,force:true});});
  return {root,options,registry,log,marker};
}

test('subscription registration rejects credentials/endpoints and remains inert without choosing a model',()=>{
  assert.deepEqual(buildProviderConfig({id:'account',preset:'chatgpt'}),{id:'account',name:'ChatGPT subscription',kind:'chatgpt-subscription',authType:'oauth'});
  for(const extra of [{apiKeyEnv:'OPENAI_API_KEY'},{baseUrl:'https://example.test/v1'}])assert.throws(()=>buildProviderConfig({id:'account',preset:'chatgpt',...extra}),/unsupported/);
});

test('subscription commands keep login/status/models/health on the same trusted auth home and redact account identity',async(t)=>{
  const f=await fixture(t), progress=[];
  await providerCommand(f.root,['add','--id','account','--preset','chatgpt'],f.options);await assert.rejects(fs.access(f.log),{code:'ENOENT'});
  const status=await providerCommand(f.root,['auth-status','account'],f.options);assert.equal(status.data.authenticated,false);
  const login=await providerCommand(f.root,['login','account','--device'],{...f.options,onProgress:text=>progress.push(text)});assert.equal(login.data.authenticated,true);assert.ok(progress.some(text=>text.includes('TEST-CODE')));assert.ok(!JSON.stringify(login).includes('PRIVATE_ACCOUNT_EMAIL'));
  const models=await providerCommand(f.root,['models','account'],f.options);assert.deepEqual(models.models,['selected-model']);
  assert.equal((await providerCommand(f.root,['test','account'],f.options)).exitCode,0);
  assert.equal((await f.registry.get('account')).approved,false);assert.deepEqual(await f.registry.getRoles(),{});
  await providerCommand(f.root,['logout','account'],f.options);assert.equal((await providerCommand(f.root,['auth-status','account'],f.options)).data.authenticated,false);
  const messages=(await fs.readFile(f.log,'utf8')).trim().split('\n').map(JSON.parse);assert.ok(messages.some(m=>m.method==='model/list'));assert.ok(!messages.some(m=>m.method==='turn/start'));
});

test('TUI subscription picker and cancellable login use the real provider command boundary',async(t)=>{
  const f=await fixture(t);await providerCommand(f.root,['add','--id','account','--preset','chatgpt'],f.options);let state=initialState();
  const picker=await executeTuiCommand(parseTuiCommand('/connect subscription'),state,f.root,undefined,{providerOptions:f.options});assert.equal(picker.state.picker.items[0].insert,'/providers add --id chatgpt --preset chatgpt');
  const result=await executeTuiCommand(parseTuiCommand('/providers login account --device'),state,f.root,update=>{state=update(state);},{providerOptions:f.options});assert.ok(result.runtime);await result.runtime.completion;assert.ok(state.outputLines.some(line=>line.includes('sign-in completed')));assert.ok(!state.outputLines.join('\n').includes('PRIVATE_ACCOUNT_EMAIL'));
});

test('subscription wizard saves only an unapproved route and prints explicit sign-in without changing roles',async(t)=>{
  const f=await fixture(t), answers=['3','account'], output=[];
  await runProviderSetupWizard(f.registry,{question:async()=>answers.shift(),write:text=>output.push(text)});
  assert.equal(answers.length,0);assert.equal((await f.registry.get('account')).approved,false);assert.deepEqual(await f.registry.getRoles(),{});assert.ok(output.some(line=>line.includes('providers login account --device')));await assert.rejects(fs.access(f.log),{code:'ENOENT'});
});
