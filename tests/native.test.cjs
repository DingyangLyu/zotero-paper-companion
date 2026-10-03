const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const path=require('node:path');
function setup(configs=[]){
 const prefs=new Map([['extensions.paper-companion.engines',JSON.stringify(configs)]]);const binaries=new Set(['/home/user/.nvm/versions/node/v24.18.0/bin/codex','/home/user/.nvm/versions/node/v24.9.0/bin/codex','/home/user/.local/bin/claude']);
 const scope={PaperEngines:{ENGINES:[{id:'codex',name:'Codex'},{id:'claude',name:'Claude Code'},{id:'opencode',name:'OpenCode'}]},Services:{env:{get:()=>'/usr/bin:/bin'},dirsvc:{get:()=>({path:'/home/user'})}},Ci:{nsIFile:{}},PathUtils:{join:path.posix.join},IOUtils:{getChildren:async()=>['/home/user/.nvm/versions/node/v24.9.0','/home/user/.nvm/versions/node/v24.18.0'],stat:async p=>{if(binaries.has(p))return {type:'regular'};throw Error('missing');}},Zotero:{Prefs:{get:k=>prefs.get(k),set:(k,v)=>prefs.set(k,v)},debug:()=>{}}};
 vm.createContext(scope);vm.runInContext(fs.readFileSync('plugin/content/native.js','utf8'),scope);return {api:scope.PaperNative,prefs,scope};
}
test('blank engine paths are automatically resolved and saved; newest NVM version wins',async()=>{
 const s=setup();const cfg=await s.api.ensureCLIConfig('codex');assert.equal(cfg.path,'/home/user/.nvm/versions/node/v24.18.0/bin/codex');assert.equal(s.api.configs().find(x=>x.id==='codex').path,cfg.path);
});
test('manual paths and models are preserved during autodetection',async()=>{
 const s=setup([{id:'codex',path:'/chosen/codex',model:'my-model'}]);const c=await s.api.ensureCLIConfig('codex');assert.equal(c.path,'/chosen/codex');assert.equal(c.model,'my-model');
});
test('manual edit during detection is not overwritten by late results',async()=>{
 const s=setup();let release;s.scope.IOUtils.getChildren=()=>new Promise(r=>release=r);const p=s.api.ensureCLIConfig('codex');s.api.saveConfigs([{id:'codex',path:'/manual/codex',model:'manual'}]);release([]);const c=await p;assert.equal(c.path,'/manual/codex');
});
test('missing CLI is left configurable; API profiles are not rewritten',async()=>{
 const s=setup([{id:'api-local',type:'api',baseURL:'http://127.0.0.1:1/v1',model:'local'}]);assert.equal((await s.api.ensureCLIConfig('opencode')).path,'');assert.equal((await s.api.ensureCLIConfig('api-local')).model,'local');const detected=await s.api.discoverEngines();assert.equal(detected.length,2);
});
