(function(g) {
  'use strict';
  const PREFIX='extensions.paper-companion.';
  function configs() {
    let value;
    try{value=JSON.parse(g.Zotero.Prefs.get(PREFIX+'engines',true) || '[]');}catch(_){value=[];}
    if(!Array.isArray(value))value=[];
    const locals=g.PaperEngines.ENGINES.map(e=>({...e,path:'',model:'',type:'cli',...value.find(x=>x.id===e.id)}));
    return [...locals,...value.filter(x=>x.type==='api' && /^api-[a-zA-Z0-9-]+$/.test(x.id)).map(x=>({...x}))];
  }
  function saveConfigs(value) {
    const clean=value.map(x=>({id:x.id,name:x.name,type:x.type,path:x.path || '',model:x.model || '',protocol:x.protocol || 'openai',baseURL:x.baseURL || '',modelEffort:x.modelEffort || '',models:Array.isArray(x.models)?x.models.slice(0,100):[]}));
    g.Zotero.Prefs.set(PREFIX+'engines',JSON.stringify(clean),true);
  }
  async function keyFor(id) {
    const logins=await g.Services.logins.searchLoginsAsync({origin:'chrome://paper-companion',httpRealm:'Paper Companion API'});
    return logins.find(x=>x.username===id)?.password || '';
  }
  async function saveKey(id,key) {
    const logins=await g.Services.logins.searchLoginsAsync({origin:'chrome://paper-companion',httpRealm:'Paper Companion API'});
    const old=logins.find(x=>x.username===id);
    if(!key){if(old)g.Services.logins.removeLogin(old);return;}
    const LoginInfo=new g.Components.Constructor('@mozilla.org/login-manager/loginInfo;1',g.Ci.nsILoginInfo,'init');
    const login=new LoginInfo('chrome://paper-companion',null,'Paper Companion API',id,key,'','');
    if(old)g.Services.logins.modifyLogin(old,login);else await g.Services.logins.addLoginAsync(login);
  }
  function getReader(body) {
    const tabID=body.closest('item-details')?.tabID || body.closest('item-details')?.dataset?.tabId;
    return tabID ? g.Zotero.Reader.getByTabID(tabID) : null;
  }
  function storageRoot() {return g.PathUtils.join(g.Zotero.DataDirectory.dir,'paper-companion');}
  async function paperIdentity(itemID) {
    const item=await g.Zotero.Items.getAsync(itemID);
    if(!item?.isPDFAttachment())throw new Error('请打开一份 PDF');
    const parent=item.parentItemID?await g.Zotero.Items.getAsync(item.parentItemID):null;
    return {item,title:parent?.getField('title') || item.getField('title') || '未命名论文',key:item.libraryID+'_'+item.key,hash:await item.attachmentHash};
  }
  async function loadHistory(key,id) {
    try {const data=JSON.parse(await g.IOUtils.readUTF8(g.PathUtils.join(storageRoot(),key,id+'.json')));if(Array.isArray(data.messages))return data.messages.filter(x=>['user','assistant'].includes(x.role)).slice(-100);}catch(e){if(e.name!=='NotFoundError')g.Zotero.debug('Paper Companion: history unavailable');}
    return [];
  }
  async function saveHistory(key,id,messages) {
    const dir=g.PathUtils.join(storageRoot(),key);await g.IOUtils.makeDirectory(dir,{ignoreExisting:true,createAncestors:true});
    const path=g.PathUtils.join(dir,id+'.json');await g.IOUtils.writeUTF8(path,JSON.stringify({version:1,messages:messages.slice(-100)}),{tmpPath:path+'.tmp'});
  }
  async function executablePaths(id) {
    const home=g.Services.dirsvc.get('Home',g.Ci.nsIFile).path;
    const bins=(g.Services.env.get('PATH') || '').split(':').filter(Boolean);
    bins.push(g.PathUtils.join(home,'.local','bin'),g.PathUtils.join(home,'.opencode','bin'),'/opt/homebrew/bin','/usr/local/bin');
    const nvm=g.PathUtils.join(home,'.nvm','versions','node');
    try {const dirs=(await g.IOUtils.getChildren(nvm)).slice(0,128).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}));bins.unshift(...dirs.map(dir=>g.PathUtils.join(dir,'bin')));}catch(_){}
    const result=[];
    for(const dir of [...new Set(bins)]) {
      const path=g.PathUtils.join(dir,id);
      try {const stat=await g.IOUtils.stat(path);if(stat.type==='regular')result.push(path);}catch(_){}
    }
    return [...new Set(result)];
  }
  const resolving=new Map();
  async function ensureCLIConfig(id) {
    const current=configs().find(c=>c.id===id);
    if(!current || current.type!=='cli' || current.path)return current;
    if(resolving.has(id))return resolving.get(id);
    const job=(async()=>{
      const candidates=await executablePaths(id);
      // A user may edit the path while detection is in progress.
      const latest=configs(),config=latest.find(c=>c.id===id);
      if(config && !config.path && candidates.length){config.path=candidates[0];saveConfigs(latest);}
      return config;
    })();resolving.set(id,job);
    try{return await job;}finally{resolving.delete(id);}
  }
  async function discoverEngines() {
    const found=[];
    for(const engine of g.PaperEngines.ENGINES){try{const config=await ensureCLIConfig(engine.id);if(config?.path)found.push({...config});}catch(e){g.Zotero.debug('Paper Companion: engine detection unavailable for '+engine.id);}}
    return found;
  }
  async function codexModels(config,signal) {
    const {Subprocess}=g.ChromeUtils.importESModule('resource://gre/modules/Subprocess.sys.mjs');
    const nodePaths=await executablePaths('node');
    const path=[g.PathUtils.parent(config.path),...nodePaths.map(p=>g.PathUtils.parent(p)),g.Services.env.get('PATH'),'/usr/bin','/bin'].filter(Boolean).join(':');
    const process=await Subprocess.call({command:config.path,arguments:['app-server'],environmentAppend:true,environment:{PATH:path,NO_COLOR:'1'},stderr:'pipe'});
    let resolve,reject;const pending=new Promise((a,b)=>{resolve=a;reject=b;});
    const stop=()=>{try{process.kill();}catch(_) {}};
    const abort=()=>{reject(Error('已停止读取模型'));stop();};signal?.addEventListener('abort',abort,{once:true});
    const win=g.Zotero.getMainWindow(),timer=win.setTimeout(()=>{reject(Error('读取 Codex 模型超时'));stop();},15000);
    const lines=new g.PaperEngines.Lines(line=>{
      if(!line.trim())return;const m=JSON.parse(line);
      if(m.id===1){if(m.error){reject(Error(m.error.message));return;}process.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n'+JSON.stringify({id:2,method:'model/list',params:{limit:100,includeHidden:false}})+'\n').catch(reject);}
      if(m.id===2){if(m.error)reject(Error(m.error.message));else{try{resolve(g.PaperEngines.modelOptions(m.result));}catch(e){reject(e);}}}
    });
    const output=(async()=>{let chunk;while((chunk=await process.stdout.readString()))lines.push(chunk);lines.end();reject(Error('Codex 模型目录连接提前关闭'));})().catch(reject);
    const errors=(async()=>{while(await process.stderr.readString()){};})().catch(()=>{});
    try{
      if(signal?.aborted)abort();
      await process.stdin.write(JSON.stringify({id:1,method:'initialize',params:{clientInfo:{name:'paper_companion',title:'Paper Companion',version:'0.1.4'}}})+'\n');
      const models=await pending;if(!models.length)throw Error('Codex 没有返回可选模型');return models;
    }finally{win.clearTimeout(timer);signal?.removeEventListener('abort',abort);stop();await Promise.allSettled([output,errors,process.wait()]);}
  }
  async function ensureCodexModel(config,{refresh=false,signal}={}) {
    if(config?.id!=='codex'||(!refresh&&config.model))return config;
    const models=await codexModels(config,signal),latest=configs(),current=latest.find(c=>c.id==='codex');
    if(!current || current.path!==config.path)return current;
    current.models=models;
    if(!current.model){const selected=models.find(m=>m.isDefault) || models[0];current.model=selected.id;current.modelEffort=selected.effort;}
    if(!current.modelEffort)current.modelEffort=models.find(m=>m.id===current.model)?.effort || '';
    saveConfigs(latest);return {...current};
  }
  async function collectCommand(command,args,{signal,limit=25000000}={}) {
    const {Subprocess}=g.ChromeUtils.importESModule('resource://gre/modules/Subprocess.sys.mjs');
    const p=await Subprocess.call({command,arguments:args,stderr:'pipe'});let output='',error='';
    const stop=()=>{try{p.kill();}catch(_) {}};signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
    const timer=g.Zotero.getMainWindow().setTimeout(stop,120000);
    try {
      await Promise.all([(async()=>{let s;while((s=await p.stdout.readString())){output+=s;if(output.length>limit)throw new Error('文档文本超过本地解析上限');}})(),(async()=>{let s;while((s=await p.stderr.readString()))error=(error+s).slice(-1000);})()]);
      const result=await p.wait();if(signal?.aborted)throw new Error('已停止');if(result.exitCode!==0)throw new Error('本地解析失败：'+g.PaperCore.redact(error));return output;
    } finally {stop();await p.wait().catch(()=>{});signal?.removeEventListener('abort',stop);g.Zotero.getMainWindow().clearTimeout(timer);}
  }
  function blockText(node,depth=0) {
    if(depth>16)return '';
    if(typeof node==='string')return node;
    if(Array.isArray(node))return node.map(x=>blockText(x,depth+1)).join('');
    if(!node || typeof node!=='object')return '';
    if(typeof node.text==='string')return node.text;
    if(typeof node.value==='string' && /text/i.test(node.type || ''))return node.value;
    for(const key of ['content','children','runs','inlines','lines'])if(node[key])return blockText(node[key],depth+1);
    return '';
  }
  const cache=new Map();
  async function readPaper(identity,win,signal) {
    const key=identity.key+':'+identity.hash;
    if(cache.has(key))return cache.get(key);
    let blocks=[],pageCount=0;
    // Zotero 10 SDT preserves logical paragraphs and source page boundaries.
    try {
      const pack=await g.Zotero.SDT.getReader(identity.item.id,{isPriority:true});
      if(pack){const catalog=await pack.getCatalog();pageCount=catalog.pages?.length || 0;
        if(pageCount>1000)throw new Error('论文超过 1000 页');
        for(let pageIndex=0;pageIndex<pageCount;pageIndex++){
          if(signal?.aborted)throw new Error('已停止');
          const page=await pack.getPageBlocks(pageIndex);
          for(const block of page){const text=g.PaperCore.normalize(blockText(block));if(text)blocks.push({text,pageIndex,index:blocks.length,rect:block.anchor?.pageRects?.find(r=>Array.isArray(r)&&r[0]===pageIndex&&r.length===5)?.slice(1) || block.source?.rect || block.position?.rects?.[0]});}
        }
      }
    }catch(e){if(signal?.aborted)throw e;blocks=[];}
    if(!blocks.length){
      let binary='';for(const p of ['/opt/homebrew/bin/pdftotext','/usr/local/bin/pdftotext','/usr/bin/pdftotext']){try{if((await g.IOUtils.stat(p)).type==='regular'){binary=p;break;}}catch(_){}}
      if(!binary)throw new Error('未能读取段落；此 PDF 可能是扫描件，或需要安装 pdftotext');
      const file=await identity.item.getFilePathAsync();if(!file)throw new Error('PDF 本地文件不可用');
      const xml=await collectCommand(binary,['-bbox-layout','-enc','UTF-8',file,'-'],{signal});
      const parsed=new win.DOMParser().parseFromString(xml,'application/xml');const pages=parsed.getElementsByTagName('page');pageCount=pages.length;
      for(let i=0;i<pages.length;i++){
        const height=Number(pages[i].getAttribute('height'));
        for(const b of pages[i].getElementsByTagName('block')){
          const text=g.PaperCore.normalize([...b.getElementsByTagName('line')].map(l=>[...l.getElementsByTagName('word')].map(w=>w.textContent).join(' ')).join('\n'));
          if(text)blocks.push({text,pageIndex:i,index:blocks.length,rect:[Number(b.getAttribute('xMin')),height-Number(b.getAttribute('yMax')),Number(b.getAttribute('xMax')),height-Number(b.getAttribute('yMin'))]});
        }
      }
    }
    if(!blocks.length)throw new Error('PDF 没有可提取的文字；扫描件需先进行 OCR');
    const result={blocks,pageCount};cache.set(key,result);if(cache.size>8)cache.delete(cache.keys().next().value);return result;
  }
  async function workdir(key) {const dir=g.PathUtils.join(storageRoot(),key,'runtime');await g.IOUtils.makeDirectory(dir,{ignoreExisting:true,createAncestors:true});return dir;}
  const api={PREFIX,configs,saveConfigs,keyFor,saveKey,getReader,paperIdentity,loadHistory,saveHistory,executablePaths,ensureCLIConfig,discoverEngines,codexModels,ensureCodexModel,collectCommand,blockText,readPaper,workdir};
  g.PaperNative=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
