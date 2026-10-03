const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const {JSDOM}=require('jsdom');
const Core=require('../plugin/content/core.js');const Engines=require('../plugin/content/engines.js');
function setup(){
 const dom=new JSDOM('<item-details><div id="body"></div></item-details>');const win=dom.window;win.ZoteroPane={};win.fetch=global.fetch;win.TextDecoder=global.TextDecoder;win.document.querySelector('item-details').tabID='reader-1';
 const prefs=new Map();let reader={itemID:7,tabID:'reader-1',navigate:()=>{}};let resolvers=[];
 let configurations=[{id:'codex',name:'Codex',type:'cli',path:'/fake/codex'},{id:'opencode',name:'OpenCode',type:'cli',path:'/fake/opencode'},{id:'claude',name:'Claude Code',type:'cli',path:'/fake/claude'}];
 const native={PREFIX:'extensions.paper-companion.',getReader:()=>reader,configs:()=>configurations,saveConfigs:c=>configurations=c,paperIdentity:async id=>({title:'Test paper',key:'1_AAA',item:{id},hash:'hash'}),loadHistory:()=>new Promise(resolve=>resolvers.push(resolve)),saveHistory:async()=>{},readPaper:async()=>({blocks:[{text:'Quantum wave function is normalized.',pageIndex:0}],pageCount:2}),workdir:async()=>'/tmp/fake',ensureCLIConfig:async id=>configurations.find(c=>c.id===id),ensureCodexModel:async c=>({...c,model:'available-model',models:[{id:'available-model',name:'Available'}]})};
 const scope={PaperNative:native,PaperCore:Core,PaperEngines:{...Engines,runCLI:async(c,m,o)=>{o.onText('答案 [p.1]');return '答案 [p.1]';}},PaperRender:{render:(d,n,t)=>n.textContent=t},Zotero:{Reader:{getByTabID:id=>id==='reader-1'?reader:null},Items:{get:()=>({isPDFAttachment:()=>true})},Prefs:{get:k=>prefs.get(k),set:(k,v)=>prefs.set(k,v)},launchURL:()=>{},getMainWindows:()=>[win]},Services:{env:{get:()=>''}},PathUtils:{parent:()=>'/fake'}};
 vm.createContext(scope);vm.runInContext(fs.readFileSync('plugin/content/popup.js','utf8'),scope);vm.runInContext(fs.readFileSync('plugin/content/main.js','utf8'),scope);const plugin=scope.PaperCompanionPlugin;const body=win.document.querySelector('#body');plugin.runtimePath=async()=>'/fake';plugin.render({doc:win.document,body});const view=plugin.views.get(body);
 return {plugin,view,body,win,native,resolvers,setReader:r=>reader=r};
}
test('paper pane prevents sending until history loaded; then translates using selected context',async()=>{
 const s=setup();assert(s.view.ask.disabled);await new Promise(r=>setImmediate(r));s.resolvers[0]([]);await new Promise(r=>setImmediate(r));assert(!s.view.ask.disabled);
 s.view.quote={text:'wave function',pageIndex:0,itemID:7};await s.plugin.send(s.view,'translate');
 assert.equal(s.view.history.length,2);assert.equal(s.view.history[1].status,'complete');assert(s.view.context.textContent.includes('Quantum wave function'));
 assert.equal(s.view.quote,null);assert(!s.view.ask.disabled);s.plugin.destroyView(s.body);s.win.close();
});
test('late history load cannot restore destroyed view or different paper',async()=>{
 const s=setup();await new Promise(r=>setImmediate(r));s.plugin.destroyView(s.body);s.resolvers[0]([{role:'assistant',text:'stale'}]);await new Promise(r=>setImmediate(r));assert.equal(s.view.history.length,0);assert(!s.plugin.views.has(s.body));s.win.close();
});
test('model picker preserves catalog and custom choices across engines and applies chosen model to requests',async()=>{
 const s=setup();await new Promise(r=>setImmediate(r));s.resolvers[0]([]);await new Promise(r=>setImmediate(r));
 const configs=s.native.configs();configs[0].models=[{id:'catalog-model',name:'Catalog model'}];s.native.saveConfigs(configs);s.plugin.modelOptions(s.view);
 s.view.modelMenu.value='catalog-model';s.view.modelMenu.dispatchEvent(new s.win.Event('change'));assert.equal(s.native.configs()[0].model,'catalog-model');assert.equal(s.view.model.value,'catalog-model');
 s.view.engines.value='opencode';s.view.engines.dispatchEvent(new s.win.Event('change'));await new Promise(r=>setImmediate(r));s.resolvers[1]([]);await new Promise(r=>setImmediate(r));
 assert(!s.view.modelMenu.hidden);assert.equal(s.view.modelMenu.selectedOptions[0].textContent,'引擎默认');assert(s.view.modelBox.hidden);
 s.view.modelMenu.value='__custom__';s.view.modelMenu.dispatchEvent(new s.win.Event('change'));assert(!s.view.modelBox.hidden);s.view.model.value='provider/model';s.view.model.dispatchEvent(new s.win.Event('change'));
 assert.equal(s.native.configs().find(c=>c.id==='opencode').model,'provider/model');assert.equal(s.native.configs()[0].model,'catalog-model');assert.equal(s.view.modelMenu.selectedOptions[0].textContent,'provider/model');
 s.view.input.value='Explain normalization';await s.plugin.send(s.view,'qa');assert.equal(s.view.history.at(-1).model,'provider/model');assert.equal(s.view.history.at(-1).engineName,'OpenCode');assert(s.view.status.hidden);s.plugin.destroyView(s.body);s.win.close();
});
test('starting a new conversation clears old context so its pages cannot be mistaken for new evidence',async()=>{
 const s=setup();await new Promise(r=>setImmediate(r));s.resolvers[0]([]);await new Promise(r=>setImmediate(r));
 s.view.quote={text:'wave function',pageIndex:0,itemID:7};await s.plugin.send(s.view,'translate');assert(s.view.contextBlocks.length);s.view.contextDetails.open=true;
 s.view.newChat.click();await new Promise(r=>setImmediate(r));assert.equal(s.view.contextBlocks.length,0);assert(!s.view.contextDetails.open);assert.equal(s.view.contextMeta.textContent,'未引用');assert.equal(s.view.history.length,0);s.plugin.destroyView(s.body);s.win.close();
});
test('selection popup refuses a reader whose tab is now bound to a different attachment',()=>{
 const s=setup();s.setReader({itemID:99,tabID:'reader-1'});let appended=false;
 s.plugin.selectionPopup({reader:{itemID:7,tabID:'reader-1'},doc:s.win.document,params:{annotation:{text:'wave',position:{pageIndex:0}}},append:()=>appended=true});assert(!appended);s.plugin.destroyView(s.body);s.win.close();
});
test('selection translation renders inline without opening sidebar; QA still carries quote to chat',async()=>{
 const s=setup();await new Promise(r=>setImmediate(r));s.resolvers[0]([]);await new Promise(r=>setImmediate(r));
 let opened=0;s.plugin.openPane=()=>opened++;s.plugin.send=()=>assert.fail('Popup translation must not call sidebar send');
 s.plugin.selectionPopup({reader:{itemID:7,tabID:'reader-1'},doc:s.win.document,params:{annotation:{text:'wave function',position:{pageIndex:0}}},append:e=>s.win.document.body.append(e)});
 const popup=[...s.plugin.popupUI.states.values()][0];popup.translate.click();await popup.running;assert.equal(opened,0);assert.match(popup.output.textContent,/答案/);assert.equal(s.view.history.length,0);
 popup.qa.click();assert.equal(opened,1);assert.equal(s.view.quote.text,'wave function');assert.match(s.view.input.value,/所选内容/);s.plugin.popupUI.shutdown();s.plugin.destroyView(s.body);s.win.close();
});
test('Fluent section titles are attributes so localization preserves child DOM',()=>{
 for(const lang of ['en-US','zh-CN']){const f=fs.readFileSync('plugin/locale/'+lang+'/paper-companion.ftl','utf8');assert.match(f,/pc-pane-header =\s*\n\s+\.label =/);assert.match(f,/pc-pane-sidenav =\s*\n\s+\.tooltiptext =/);}
});
test('opening pane handles Zotero escaped registered pane IDs',()=>{
 const s=setup();const details=s.win.document.querySelector('item-details');const btn=s.win.document.createElement('button');btn.dataset.pane='paper-companion\\@yuanbai\\.local-paper-companion';const nav=s.win.document.createElement('div');nav.append(btn);details.sidenav=nav;s.plugin.paneID=btn.dataset.pane;let clicked=false;btn.onclick=()=>clicked=true;s.plugin.openPane({tabID:'reader-1'});assert(clicked);s.plugin.destroyView(s.body);s.win.close();
});
