import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCodexAppServer } from '../dist/providers/codex-app-server.js';
import { ChatGptSubscriptionAdapter } from '../dist/providers/adapters/chatgpt-subscription.js';

const childSource = String.raw`
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';
const [mode, trace] = process.argv.slice(2);
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const event = (method, params) => send({method, params});
const reply = (id, result) => send({id, result});
appendFileSync(trace, JSON.stringify({event:'spawn',home:process.env.CODEX_HOME,cwd:process.cwd(),secretPresent:!!process.env.HIVE_FIXTURE_SECRET,args:process.argv.slice(4)})+'\n');
readline.createInterface({input:process.stdin}).on('line', line => {
 const request=JSON.parse(line);
 appendFileSync(trace, JSON.stringify(request)+'\n');
 if(request.method==='initialize') { if(mode!=='stalled')reply(request.id, {userAgent:'fixture'}); }
 else if(request.method==='account/read') reply(request.id,{account:mode==='signed-out'?null:{type:'chatgpt',email:'do-not-expose@example.test',planType:'plus'},requiresOpenaiAuth:true});
 else if(request.method==='account/login/start') {
  if(request.params.type==='chatgptDeviceCode')reply(request.id,{type:'chatgptDeviceCode',loginId:'login-1',verificationUrl:'https://auth.openai.com/codex/device',userCode:'ABCD-1234'});
  else reply(request.id,{type:'chatgpt',loginId:'login-1',authUrl: mode==='bad-url'?'https://evil.example/auth':'https://auth.openai.com/authorize?state=fixture'});
  if(mode!=='pending-login')setTimeout(()=>event('account/login/completed',{loginId:'unrelated',success:true}),5);
  if(mode!=='pending-login')setTimeout(()=>event('account/login/completed',{loginId:'login-1',success:true}),20);
 }
 else if(request.method==='account/login/cancel')reply(request.id,{});
 else if(request.method==='account/logout')reply(request.id,{});
 else if(request.method==='model/list') reply(request.id,{data:[{id:'catalog-id',model:'fixture-model',displayName:'Fixture',supportedReasoningEfforts:[{reasoningEffort:'high',description:'High'}],defaultReasoningEffort:'high',serviceTiers:[{id:'priority',name:'Priority'}],defaultServiceTier:'priority'}],nextCursor:mode==='loop-models'?'repeated':null});
 else if(request.method==='thread/start')reply(request.id,{thread:{id:'thread-1',ephemeral:true},model:request.params.model,modelProvider:'openai',instructionSources:mode==='ambient'?['C:/Users/other/AGENTS.md']:[],approvalPolicy:'never',sandbox:{type:'readOnly',networkAccess:false}});
 else if(request.method==='turn/start') {
  reply(request.id,{turn:{id:'turn-1',status:'inProgress'}});
  if(mode==='hold-turn')return;
  setTimeout(()=>{
   if(mode==='tool') {send({id:'approval-1',method:'item/commandExecution/requestApproval',params:{threadId:'thread-1',turnId:'turn-1'}});return;}
   if(mode==='many-items') {for(let n=0;n<257;n++)event('item/completed',{threadId:'thread-1',turnId:'turn-1',item:{type:'agentMessage',id:'item-'+n,text:'x',phase:'final_answer'}});return;}
   if(mode==='large-items') {for(let n=0;n<9;n++)event('item/completed',{threadId:'thread-1',turnId:'turn-1',item:{type:'agentMessage',id:'item-'+n,text:'x'.repeat(1024*1024),phase:'final_answer'}});return;}
   if(mode==='hive-json') {event('item/completed',{threadId:'thread-1',turnId:'turn-1',item:{type:'agentMessage',id:'answer',phase:'final_answer',text:JSON.stringify({done:false,toolCalls:[{name:'write_file',arguments:{path:'probe.txt',content:'proof'}}]})}});event('turn/completed',{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}});return;}
   event('item/agentMessage/delta',{threadId:'another',turnId:'turn-1',itemId:'no',delta:'WRONG'});
   event('item/started',{threadId:'thread-1',turnId:'turn-1',item:{type:'agentMessage',id:'commentary',phase:'commentary'}});
   event('item/agentMessage/delta',{threadId:'thread-1',turnId:'turn-1',itemId:'commentary',delta:'private commentary'});
   event('item/started',{threadId:'thread-1',turnId:'turn-1',item:{type:'agentMessage',id:'answer',phase:'final_answer'}});
   event('item/agentMessage/delta',{threadId:'thread-1',turnId:'turn-1',itemId:'answer',delta:'hello '});
   event('item/agentMessage/delta',{threadId:'thread-1',turnId:'turn-1',itemId:'answer',delta:'world'});
   event('thread/tokenUsage/updated',{threadId:'thread-1',turnId:'turn-1',tokenUsage:{last:{inputTokens:5,outputTokens:2,totalTokens:7}}});
   event('turn/completed',{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}});
  },10);
 }
 else if(request.method==='turn/interrupt')reply(request.id,{});
});
`;

async function fixture(t, mode = 'normal') {
  const root = await mkdtemp(path.join(tmpdir(), 'hive-codex-fixture-'));
  const script = path.join(root, 'server.mjs');
  const trace = path.join(root, 'trace.jsonl');
  await writeFile(script, childSource);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { options: { executable: process.execPath, args: [script, mode, trace], homeDir: path.join(root, 'own-auth'), requestTimeoutMs: 1_000 },
    trace: async () => (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) };
}

const config = { id:'chatgpt',name:'ChatGPT',kind:'chatgpt-subscription',authType:'oauth',approved:true,createdAt:'now',updatedAt:'now' };

test('ChatGPT app-server uses isolated home, safe child flags, and whitelisted account status', async t => {
  const f = await fixture(t);
  process.env.HIVE_FIXTURE_SECRET='must-not-inherit';
  t.after(()=>delete process.env.HIVE_FIXTURE_SECRET);
  const client = await createCodexAppServer(f.options);
  try {
    assert.deepEqual(await client.accountStatus(), { authenticated:true,authMode:'chatgpt',planType:'plus' });
    const model = (await client.listModels())[0];
    assert.equal(model.id,'catalog-id');
    assert.equal(model.model,'fixture-model');
    assert.deepEqual(model.supportedReasoningEfforts,['high']);
    assert.deepEqual(model.serviceTiers,['priority']);
  } finally { await client.close(); }
  const trace = await f.trace();
  assert.equal(trace[0].home,f.options.homeDir);
  assert.equal(trace[0].secretPresent,false);
  assert.ok(trace[0].args.includes('cli_auth_credentials_store="keyring"'));
  assert.ok(trace[0].args.includes('features.shell_tool=false'));
  assert.ok(trace[0].args.includes('features.image_generation=false'));
  assert.notEqual(trace[0].cwd,process.cwd());
});

test('ChatGPT managed browser and device login correlate completion notifications', async t => {
  const f = await fixture(t);
  const client=await createCodexAppServer(f.options);
  try {
    const login=await client.startLogin({method:'device'});
    assert.equal(login.type,'device');
    assert.equal(login.verificationUrl,'https://auth.openai.com/codex/device');
    assert.deepEqual(await client.waitForLogin(login.loginId,{timeoutMs:500}),{success:true});
    const browser=await client.startLogin({method:'browser'});
    assert.equal(browser.type,'browser');
    await client.cancelLogin(browser.loginId);
    await client.logout();
  } finally {await client.close();}
});

test('ChatGPT login rejects non-official URLs', async t => {
  const f=await fixture(t,'bad-url');
  const client=await createCodexAppServer(f.options);
  try {await assert.rejects(client.startLogin({method:'browser'}),/official HTTPS/);}finally{await client.close();}
});

test('ChatGPT startup abort closes a genuinely stalled child promptly', async t => {
  const f=await fixture(t,'stalled');
  const abort=new AbortController();
  setTimeout(()=>abort.abort(),100);
  const started=Date.now();
  await assert.rejects(createCodexAppServer({...f.options,requestTimeoutMs:30_000,signal:abort.signal}),error=>error.name==='AbortError');
  assert.ok(Date.now()-started<3_000);
});

test('ChatGPT login abort cancels the pending managed flow', async t => {
  const f=await fixture(t,'pending-login');
  const client=await createCodexAppServer(f.options);
  try {
    const login=await client.startLogin({method:'device'});
    const abort=new AbortController();
    setTimeout(()=>abort.abort(),30);
    await assert.rejects(client.waitForLogin(login.loginId,{signal:abort.signal}),error=>error.name==='AbortError');
    await new Promise(resolve=>setTimeout(resolve,30));
    assert.ok((await f.trace()).some(row=>row.method==='account/login/cancel'));
  } finally {await client.close();}
});

test('ChatGPT streaming correlates thread events, excludes commentary, and preserves settings', async t => {
  const f=await fixture(t);
  const chunks=[];
  const adapter=new ChatGptSubscriptionAdapter(f.options);
  const result=await adapter.streamComplete(config,{model:'fixture-model',prompt:'respond'},chunk=>chunks.push(chunk));
  assert.equal(result.output,'hello world');
  assert.deepEqual(chunks,['hello ','world']);
  assert.deepEqual(result.usage,{promptTokens:5,completionTokens:2,totalTokens:7});
  const trace=await f.trace();
  const thread=trace.find(row=>row.method==='thread/start').params;
  assert.equal(thread.ephemeral,true);
  assert.equal(thread.sandbox,'read-only');
  assert.deepEqual(thread.dynamicTools,[]);
  assert.equal(thread.allowProviderModelFallback,false);
  const turn=trace.find(row=>row.method==='turn/start').params;
  assert.equal('effort' in turn,false);
  assert.equal('serviceTier' in turn,false);
});

test('ChatGPT explicit output caps and external credentials fail before child launch', async t => {
  const adapter=new ChatGptSubscriptionAdapter({executable:'missing-executable-should-not-run'});
  await assert.rejects(adapter.complete(config,{model:'fixture-model',prompt:'respond',maxOutputTokens:512}),/cannot enforce maxOutputTokens/);
  await assert.rejects(adapter.complete({...config,apiKeyEnv:'SECRET'},{model:'fixture-model',prompt:'respond'}),/without API keys/);
});

test('ChatGPT native tool approval is denied and turn interrupted', async t => {
  const f=await fixture(t,'tool');
  const adapter=new ChatGptSubscriptionAdapter(f.options);
  await assert.rejects(adapter.complete(config,{model:'fixture-model',prompt:'respond'}),/attempted tool/);
  const trace=await f.trace();
  assert.equal(trace.find(row=>row.id==='approval-1').result.decision,'decline');
  assert.ok(trace.some(row=>row.method==='turn/interrupt'));
});

test('ChatGPT refuses ambient instructions and bounded completed message floods', async t => {
  for (const [mode,pattern] of [['ambient',/ambient instruction/],['many-items',/message count limit/]]) {
    const f=await fixture(t,mode);
    const adapter=new ChatGptSubscriptionAdapter(f.options);
    await assert.rejects(adapter.complete(config,{model:'fixture-model',prompt:'respond'}),pattern);
  }
});

test('ChatGPT repeated model cursors fail instead of looping', async t => {
  const f=await fixture(t,'loop-models');
  const client=await createCodexAppServer(f.options);
  try {await assert.rejects(client.listModels(),/repeated a pagination cursor/);}finally{await client.close();}
});

test('HIVE structured tool calls remain literal provider output without native execution', async t => {
  const f=await fixture(t,'hive-json'),adapter=new ChatGptSubscriptionAdapter(f.options);
  const result=await adapter.complete(config,{model:'fixture-model',prompt:'Emit the HIVE tool request as JSON text.'});
  assert.deepEqual(JSON.parse(result.output),{done:false,toolCalls:[{name:'write_file',arguments:{path:'probe.txt',content:'proof'}}]});
  const trace=await f.trace(),start=trace.find(row=>row.method==='thread/start');
  assert.match(start.params.developerInstructions,/emit that JSON as plain text/);
  assert.deepEqual(trace.filter(row=>row.id==='approval-1'),[]);
  assert.ok(trace[0].args.includes('skills.include_instructions=false'));assert.ok(trace[0].args.includes('skills.bundled.enabled=false'));
});

test('completed messages without streaming deltas cannot exceed the stored byte limit', async t => {
  const f=await fixture(t,'large-items'),adapter=new ChatGptSubscriptionAdapter(f.options);
  await assert.rejects(adapter.complete(config,{model:'fixture-model',prompt:'Respond'}),/output size limit/);
});

test('ChatGPT auth home rejects custom config before launching any process', async t => {
  const f=await fixture(t);
  await mkdir(f.options.homeDir,{recursive:true});
  await writeFile(path.join(f.options.homeDir,'config.toml'),'[mcp_servers.untrusted]\ncommand="must-not-launch"\n');
  await assert.rejects(createCodexAppServer(f.options),/must not contain a custom config.toml/);
  await assert.rejects(f.trace(),error=>error.code==='ENOENT');
});
