const {test}=require('node:test');const assert=require('node:assert/strict');
global.PaperCore=require('../plugin/content/core.js');const Engines=require('../plugin/content/engines.js');
test('three local engines receive prompt via stdin and explicit read/tool limits',()=>{
 for(const id of ['codex','claude','opencode']){const p=Engines.cliPlan(id,{model:'chosen-model'},'private prompt');assert(!p.args.join(' ').includes('private prompt'));assert.equal(p.input,'private prompt\n');assert(p.args.includes('chosen-model'));}
 assert(Engines.cliPlan('codex',{},'x').args.includes('read-only'));
 assert(Engines.cliPlan('claude',{},'x').args.includes('--tools'));
 assert.equal(JSON.parse(Engines.cliPlan('opencode',{},'x').environment.OPENCODE_CONFIG_CONTENT).permission['*'],'deny');
});
test('decodes each native stream and handles real failure events',()=>{
 assert.equal(Engines.eventText('codex',{type:'item.completed',item:{type:'agent_message',text:'OK'}}).text,'OK');
 assert.equal(Engines.eventText('claude',{type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'a'}}}).text,'a');
 assert.equal(Engines.eventText('claude',{type:'result',result:'abc'}).replace,true);
 assert.equal(Engines.eventText('opencode',{type:'text',part:{text:'yes'}}).text,'yes');
 assert.throws(()=>Engines.eventText('codex',{type:'turn.failed',error:{message:'failed'}}),/failed/);
});
test('API adapters keep credentials in headers and preserve system message',()=>{
 const messages=[{role:'system',content:'policy'},{role:'user',content:'question'}];
 for(const protocol of ['openai','responses','anthropic']){const req=Engines.apiRequest({baseURL:'https://example.org/v1',protocol,model:'model'},messages,'private-key');assert(!JSON.stringify(req.body).includes('private-key'));assert(req.url.startsWith('https://example.org/v1/'));assert(JSON.stringify(req.body).includes('policy'));}
 assert.throws(()=>Engines.endpoint({baseURL:'http://remote.example/v1'}),/HTTPS/);
 assert.throws(()=>Engines.endpoint({baseURL:'https://example.org/v1?key=secret'}),/参数/);
});
test('bounded lines handle arbitrary network chunk boundaries',()=>{
 const lines=[];const parser=new Engines.Lines(s=>lines.push(s),10);parser.push('a\r');parser.push('\nb\nc');parser.end();assert.deepEqual(lines,['a','b','c']);assert.throws(()=>parser.push('x'.repeat(11)));
});
test('streaming API works across split UTF-8 and SSE chunks',async()=>{
 const chunks=['data: {"choices":[{"delta":{"content":"量子"}}]}\n\n','data: {"choices":[{"delta":{"content":"力学"}}]}\n\n','data: [DONE]\n\n'];
 const bytes=new TextEncoder().encode(chunks.join(''));let text='';
 const stream=new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=5)c.enqueue(bytes.slice(i,i+5));c.close();}});
 const result=await Engines.runAPI({baseURL:'https://example.org/v1',model:'fake',protocol:'openai'},[{role:'user',content:'test'}],{signal:new AbortController().signal,key:'',TextDecoder,fetch:async()=>new Response(stream,{headers:{'content-type':'text/event-stream'}}),onText:t=>text=t});
 assert.equal(result,'量子力学');assert.equal(text,result);
});
test('API error response is not reported as success',async()=>{
 await assert.rejects(Engines.runAPI({baseURL:'https://example.org/v1',model:'fake',protocol:'openai'},[],{signal:new AbortController().signal,TextDecoder,fetch:async()=>new Response('',{status:401}),onText:()=>{}}),/401/);
});
test('Codex model directory keeps only display metadata and supplied default effort',()=>{
 const options=Engines.modelOptions({data:[{model:'available',displayName:'Available',isDefault:true,defaultReasoningEffort:'medium',apiKey:'must-not-store'},{model:'hidden',hidden:true},{model:'bad model'}]});
 assert.equal(options.length,1);assert.equal(options[0].id,'available');assert.equal(options[0].effort,'medium');assert(!JSON.stringify(options).includes('must-not-store'));
 const plan=Engines.cliPlan('codex',{model:'available',modelEffort:'medium'},'test');assert(plan.args.includes('model_reasoning_effort="medium"'));
});
