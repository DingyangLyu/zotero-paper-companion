(function(g) {
  'use strict';
  const ENGINES = [{id:'codex',name:'Codex'},{id:'claude',name:'Claude Code'},{id:'opencode',name:'OpenCode'}];
  function cliPlan(id, config, prompt) {
    const model=String(config.model || '').trim();
    let args;
    if (id === 'codex') args=['exec','--json','--ephemeral','--skip-git-repo-check','--sandbox','read-only',...(model?['--model',model]:[]),...(['none','minimal','low','medium','high','xhigh','max'].includes(config.modelEffort)?['-c','model_reasoning_effort='+JSON.stringify(config.modelEffort)]:[]),'-'];
    else if (id === 'claude') args=['--print','--output-format','stream-json','--verbose','--include-partial-messages','--no-session-persistence','--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}',...(model?['--model',model]:[])];
    else if (id === 'opencode') args=['run','--pure','--format','json',...(model?['--model',model]:[])];
    else throw new Error('未知本地引擎');
    const environment={NO_COLOR:'1',TERM:'dumb'};
    if (id === 'opencode') Object.assign(environment,{OPENCODE_DISABLE_AUTOUPDATE:'true',OPENCODE_DISABLE_MODELS_FETCH:'true',OPENCODE_DISABLE_MDNS:'true',OPENCODE_CONFIG_CONTENT:JSON.stringify({permission:{'*':'deny'}})});
    return {args,input:prompt+'\n',environment};
  }
  function eventText(id, event) {
    if (id === 'codex' && event.type === 'item.completed' && event.item?.type === 'agent_message') return {text:event.item.text,replace:false};
    if (id === 'codex' && ['error','turn.failed'].includes(event.type)) throw new Error(event.message || event.error?.message || 'Codex 请求失败');
    if (id === 'claude' && event.type === 'stream_event' && event.event?.type === 'content_block_delta' && event.event.delta?.type === 'text_delta') return {text:event.event.delta.text,replace:false,stream:true};
    if (id === 'claude' && event.type === 'result') {
      if (event.is_error) throw new Error(event.result || 'Claude Code 请求失败');
      return {text:event.result || '',replace:true};
    }
    if (id === 'opencode' && event.type === 'text') return {text:event.part?.text || '',replace:false};
    if (id === 'opencode' && event.type === 'error') throw new Error(event.error?.data?.message || event.error?.message || 'OpenCode 请求失败');
    return null;
  }
  function modelOptions(result) {
    if(!Array.isArray(result?.data))throw Error('Codex 模型目录格式不正确');
    return result.data.slice(0,100).filter(m=>!m.hidden && typeof m.model==='string' && m.model.length<=200 && !/[\x00-\x20]/.test(m.model)).map(m=>({id:m.model,name:String(m.displayName || m.model).slice(0,200),isDefault:m.isDefault===true,effort:['none','minimal','low','medium','high','xhigh','max'].includes(m.defaultReasoningEffort)?m.defaultReasoningEffort:''}));
  }
  function endpoint(config) {
    const url=new URL(config.baseURL);
    if (!(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) throw new Error('API 地址需使用 HTTPS；本机接口可使用 HTTP');
    if (url.username || url.password || url.search || url.hash) throw new Error('API 地址不能包含账号、查询参数或片段');
    const suffix=config.protocol === 'anthropic' ? '/messages' : config.protocol === 'responses' ? '/responses' : '/chat/completions';
    return url.href.replace(/\/$/,'').replace(/\/(?:chat\/completions|responses|messages)$/,'')+suffix;
  }
  function apiRequest(config, messages, key) {
    if (!config.model) throw new Error('请填写 API 模型名称');
    const headers={'Content-Type':'application/json'};
    let body;
    if (config.protocol === 'anthropic') {
      if (key) headers['x-api-key']=key;
      headers['anthropic-version']='2023-06-01';
      body={model:config.model,max_tokens:4096,stream:true,system:messages.filter(m=>m.role==='system').map(m=>m.content).join('\n'),messages:messages.filter(m=>m.role!=='system')};
    } else if (config.protocol === 'responses') {
      if (key) headers.Authorization='Bearer '+key;
      body={model:config.model,stream:true,store:false,input:messages};
    } else {
      if (key) headers.Authorization='Bearer '+key;
      body={model:config.model,stream:true,messages};
    }
    return {url:endpoint(config),headers,body};
  }
  function apiEvent(config, e) {
    if (e.error || e.type==='error' || e.type==='response.failed') throw new Error(e.error?.message || e.response?.error?.message || 'API 请求失败');
    if (config.protocol==='anthropic') return e.type==='content_block_delta' && e.delta?.type==='text_delta' ? e.delta.text : '';
    if (config.protocol==='responses') return e.type==='response.output_text.delta' ? e.delta || '' : '';
    return e.choices?.[0]?.delta?.content || '';
  }
  class Lines {
    constructor(onLine, max=1048576) {this.buffer='';this.onLine=onLine;this.max=max;}
    push(chunk) {
      this.buffer+=chunk;
      let i;
      while((i=this.buffer.indexOf('\n'))>=0) {const line=this.buffer.slice(0,i).replace(/\r$/,'');this.buffer=this.buffer.slice(i+1);if(line.length>this.max)throw new Error('引擎消息过长');this.onLine(line);}
      if(this.buffer.length>this.max) throw new Error('引擎消息过长');
    }
    end() {if(this.buffer)this.onLine(this.buffer);this.buffer='';}
  }
  async function runCLI(config, messages, options) {
    const {Subprocess}=g.ChromeUtils.importESModule('resource://gre/modules/Subprocess.sys.mjs');
    const plan=cliPlan(config.id,config,messages.map(m=>m.role.toUpperCase()+':\n'+m.content).join('\n\n'));
    const env={...plan.environment,PATH:options.path};
    const process=await Subprocess.call({command:config.path,arguments:plan.args,workdir:options.workdir,environmentAppend:true,environment:env,stderr:'pipe'});
    const abort=()=>{try{process.kill();}catch(_) {}};
    options.signal.addEventListener('abort',abort,{once:true});
    if(options.signal.aborted)abort();
    let text='',stderr='';
    const lines=new Lines(line=>{
      if(!line.trim())return;
      const event=JSON.parse(line);
      const update=eventText(config.id,event);
      if(update?.text) {text=update.replace?update.text:text+update.text;if(text.length>200000)throw new Error('回复超过长度限制');options.onText(text);}
    });
    const out=(async()=>{let chunk;while((chunk=await process.stdout.readString())){if(options.signal.aborted)break;lines.push(chunk);}lines.end();})();
    const err=(async()=>{let chunk;while((chunk=await process.stderr.readString()))stderr=(stderr+chunk).slice(-4000);})();
    try {
      await process.stdin.write(plan.input);await process.stdin.close();
      await Promise.all([out,err]);const result=await process.wait();
      if(options.signal.aborted)throw new Error('已停止');
      if(result.exitCode!==0)throw new Error(g.PaperCore.redact(stderr) || '本地引擎退出，代码 '+result.exitCode);
      if(!text.trim())throw new Error('引擎没有返回文本；请检查登录、模型和本地 CLI 版本');
      return text;
    } catch(e) {abort();await process.wait().catch(()=>{});throw e;}
    finally {options.signal.removeEventListener('abort',abort);}
  }
  async function runAPI(config,messages,options) {
    const request=apiRequest(config,messages,options.key);
    const response=await options.fetch(request.url,{method:'POST',headers:request.headers,body:JSON.stringify(request.body),signal:options.signal,credentials:'omit',redirect:'error'});
    if(!response.ok)throw new Error('API 请求失败（HTTP '+response.status+'）');
    let text='',done=false;
    const add=e=>{text+=apiEvent(config,e);if(text.length>200000)throw new Error('回复超过长度限制');options.onText(text);};
    if(!response.headers.get('content-type')?.includes('text/event-stream')) {
      const e=await response.json();
      if(e.error)throw new Error('API 返回错误：'+g.PaperCore.redact(e.error.message).slice(0,500));
      text=config.protocol==='anthropic'?e.content?.filter(x=>x.type==='text').map(x=>x.text).join('') : config.protocol==='responses'?e.output?.flatMap(x=>x.content || []).filter(x=>x.type==='output_text').map(x=>x.text).join('') : e.choices?.[0]?.message?.content;
      if(!text)throw new Error('API 没有返回文本');options.onText(text);return text;
    }
    let data=[];
    const lines=new Lines(line=>{if(line===''){if(data.length){const s=data.join('\n');data=[];if(s==='[DONE]')done=true;else add(JSON.parse(s));}}else if(line.startsWith('data:'))data.push(line.slice(5).trimStart());});
    const reader=response.body.getReader();const decoder=new options.TextDecoder();
    try {while(!done){const chunk=await reader.read();if(chunk.done)break;lines.push(decoder.decode(chunk.value,{stream:true}));}lines.push(decoder.decode());lines.end();if(data.length)add(JSON.parse(data.join('\n')));}
    finally {await reader.cancel().catch(()=>{});}
    if(!text.trim())throw new Error('API 没有返回文本');return text;
  }
  const api={ENGINES,cliPlan,eventText,modelOptions,endpoint,apiRequest,apiEvent,Lines,runCLI,runAPI};
  g.PaperEngines=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
