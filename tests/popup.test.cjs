const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const {JSDOM}=require('jsdom');
const Core=require('../plugin/content/core.js');global.PaperCore=Core;global.marked=require('marked').marked;global.katex=require('../plugin/content/vendor/katex/katex.min.js');const Render=require('../plugin/content/render.js');
const tick=()=>new Promise(r=>setImmediate(r));
function setup(){
 const dom=new JSDOM('<item-details></item-details><div class="selection-popup"><div class="colors"><button>黄色</button></div><textarea class="zoteropdftranslate-readerpopup">CNKI error</textarea><div id="mount"></div></div>',{pretendToBeVisual:true});
 const win=dom.window;win.document.querySelector('item-details').tabID='tab-1';win.Zotero_Tabs={selectedID:'tab-1'};win.fetch=global.fetch;win.TextDecoder=global.TextDecoder;
 const prefs=new Map(),configs=[{id:'codex',type:'cli',path:'/fake/codex',model:'test-model',name:'Codex'},{id:'api-test',type:'api',baseURL:'https://api.example.com/v1',model:'api-model',name:'API'}];
 let reader={tabID:'tab-1',itemID:7,navigate:p=>calls.pages.push(p)},owner=win,notify,removed=false;
 const calls={inference:[],pages:[],qa:0,settings:0,copied:'',history:0};
 const native={PREFIX:'extensions.paper-companion.',configs:()=>configs,ensureCLIConfig:async id=>configs.find(c=>c.id===id),ensureCodexModel:async c=>({...c,model:'default-from-directory'}),paperIdentity:async()=>({key:'1_PDF',hash:'hash',title:'Paper'}),readPaper:async()=>({blocks:[{text:'Before paragraph.',pageIndex:0},{text:'The samples contain multiple images.',pageIndex:0},{text:'Following paragraph.',pageIndex:0}],pageCount:2}),workdir:async()=>'/tmp/fake',keyFor:async()=> 'secret-key',saveHistory:async()=>calls.history++};
 const engines={endpoint:()=>{},runCLI:async(c,m,o)=>{calls.inference.push({config:c,messages:m,options:o});o.onText('**样本** $r=M/N$ [p.1]');return '**样本** $r=M/N$ [p.1]';},runAPI:async(c,m,o)=>{calls.inference.push({config:c,messages:m,options:o});return 'API 译文';}};
 const scope={PaperCore:Core,PaperRender:Render,PaperNative:native,PaperEngines:engines,Zotero:{Prefs:{get:k=>prefs.get(k),set:(k,v)=>prefs.set(k,v)},Reader:{getByTabID:id=>id==='tab-1'?reader:null},getMainWindows:()=>[owner],getMainWindow:()=>owner,launchURL:()=>{},Notifier:{registerObserver:o=>{notify=o.notify;return 42;},unregisterObserver:id=>{assert.equal(id,42);removed=true;}}}};
 vm.createContext(scope);vm.runInContext(fs.readFileSync('plugin/content/popup.js','utf8'),scope);
 const plugin={styles:fs.readFileSync('plugin/content/style.css','utf8'),element:(doc,tag,cls,text)=>{const e=doc.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e;},button(doc,text,action,cls){const e=this.element(doc,'button',cls,text);e.onclick=action;return e;},runtimePath:async()=>'/fake',copyText:t=>calls.copied=t};
 const popup=new scope.PaperPopup(plugin),create=(text='samples')=>popup.create({reader,doc:win.document,quote:{itemID:7,text,pageIndex:0,pageLabel:'1',rects:[]},append:e=>win.document.querySelector('#mount').append(e),onQA:()=>calls.qa++,onSettings:()=>calls.settings++});
 return {win,popup,create,calls,native,engines,configs,prefs,setOwner:o=>owner=o,notify:(...a)=>notify(...a),removed:()=>removed,setReader:r=>reader=r,close:()=>{popup.shutdown();win.close();}};
}
test('translation stays in native popup, uses neighboring context, renders math and citations, and copies',async()=>{
 const s=setup(),p=s.create();assert.equal(s.calls.inference.length,0,'selection alone does not send requests');
 await s.popup.translate(p);assert.equal(s.calls.inference.length,1);assert.equal(s.calls.qa,0);assert.equal(s.calls.history,0);
 const sent=JSON.parse(s.calls.inference[0].messages.at(-1).content.split('\n\n').slice(1).join('\n\n'));assert.equal(sent.selected_text,'samples');assert.deepEqual(sent.context.map(b=>b.paragraph),['Before paragraph.','The samples contain multiple images.','Following paragraph.']);
 assert(p.output.querySelector('strong'));assert(p.output.querySelector('math'));p.output.querySelector('.pc-citation').click();assert.equal(s.calls.pages[0].pageIndex,0);
 p.copy.click();assert.equal(s.calls.copied,p.text);assert.match(p.status.textContent,/已复制/);assert(p.stop.hidden);p.qa.click();assert.equal(s.calls.qa,1);
 assert.equal(s.win.getComputedStyle(s.win.document.querySelector('.zoteropdftranslate-readerpopup')).display,'none');assert.notEqual(s.win.getComputedStyle(s.win.document.querySelector('.colors')).display,'none');
 s.popup.dispose(p);assert.notEqual(s.win.getComputedStyle(s.win.document.querySelector('.zoteropdftranslate-readerpopup')).display,'none');s.close();assert(s.removed());
});
test('repeat selection uses bounded in-memory cache; refresh or changed model makes a new request',async()=>{
 const s=setup();await s.popup.translate(s.create());await s.popup.translate(s.create());assert.equal(s.calls.inference.length,1);
 const p=[...s.popup.states.values()][0];await s.popup.translate(p,{refresh:true});assert.equal(s.calls.inference.length,2);
 s.configs[0].model='other-model';await s.popup.translate(s.create());assert.equal(s.calls.inference.length,3);s.close();
});
test('closing popup aborts its request and discards late result without caching it',async()=>{
 const s=setup();let resolve;s.engines.runCLI=(c,m,o)=>{s.calls.inference.push({options:o});return new Promise(r=>resolve=r);};
 const p=s.create(),job=s.popup.translate(p);await tick();assert(p.busy);p.root.remove();await tick();assert(s.calls.inference[0].options.signal.aborted);
 resolve('old result');await job;assert.equal(s.popup.cache.size,0);assert.equal(s.popup.states.size,0);s.close();
});
test('reselection and tab switch cancel requests before they can overwrite new selection',async()=>{
 const s=setup();let resolve;s.engines.runCLI=()=>new Promise(r=>resolve=r);
 const old=s.create(),job=s.popup.translate(old);await tick();const newer=s.create('images');assert(old.disposed);resolve('late result');await job;assert.equal(newer.output.textContent,'');
 s.win.Zotero_Tabs.selectedID='library';s.notify('select','tab',['library']);assert(newer.disposed);assert.equal(s.popup.states.size,0);s.close();
});
test('stop preserves partial text but does not cache it; switching engine uses custom API',async()=>{
 const s=setup();s.engines.runCLI=async(c,m,o)=>{o.onText('partial');o.signal.addEventListener('abort',()=>{}, {once:true});await tick();throw Error('stopped');};
 const p=s.create(),job=s.popup.translate(p);await tick();p.stop.click();await job;assert.match(p.status.textContent,/已停止/);assert.equal(p.output.textContent.trim(),'partial');assert.equal(s.popup.cache.size,0);
 p.engines.value='api-test';p.engines.dispatchEvent(new s.win.Event('change'));await s.popup.translate(p);assert.equal(p.text,'API 译文');assert.equal(s.calls.inference[0].options.key,'secret-key');s.close();
});
test('missing context is explicit and missing engine path leaves recoverable error',async()=>{
 const s=setup(),p=s.create('not present');await s.popup.translate(p);assert.match(p.status.textContent,/仅使用选区原文/);assert.equal(s.calls.inference[0].messages.length,2);
 s.configs[0].path='';const next=s.create();await s.popup.translate(next);assert.match(next.status.textContent,/配置/);assert(!next.translate.disabled);s.close();
});
test('reader changes during context read prevent any model request',async()=>{
 const s=setup();let resolve;s.native.readPaper=()=>new Promise(r=>resolve=r);const p=s.create(),job=s.popup.translate(p);await tick();s.setReader({tabID:'tab-1',itemID:99});resolve({blocks:[],pageCount:1});await job;assert.equal(s.calls.inference.length,0);assert.equal(s.popup.cache.size,0);s.close();
});
test('growing popup stays within reader viewport using Zotero native CSS translation',()=>{
 const s=setup(),p=s.create(),host=p.root.closest('.selection-popup');s.win.innerHeight=800;host.style.transform='translate(100px, 650px)';host.getBoundingClientRect=()=>({left:100,top:650,right:460,bottom:950});host.parentElement.getBoundingClientRect=()=>({left:0,top:0,right:900,bottom:800});
 s.popup.fit(p);assert.equal(host.style.transform,'translate(100px, 492px)');s.popup.dispose(p);assert.equal(host.style.transform,'translate(100px, 650px)');s.close();
});
test('Reader DOM uses chrome-window observers and signals across Gecko compartments',async()=>{
 const s=setup(),main={document:s.win.document,Zotero_Tabs:s.win.Zotero_Tabs,closed:false,MutationObserver:s.win.MutationObserver,AbortController:s.win.AbortController,setTimeout:s.win.setTimeout.bind(s.win),clearTimeout:s.win.clearTimeout.bind(s.win)};s.setOwner(main);
 s.win.MutationObserver=class {constructor(){throw Error('Reader observer cannot read privileged options');}};s.win.AbortController=class {constructor(){throw Error('Reader signal must not cross privileged boundary');}};
 const p=s.create();assert(p.root.isConnected);assert(p.observer);assert.equal(p.win,main);assert.equal(p.contentWindow,s.win);await s.popup.translate(p);assert.match(p.output.textContent,/样本/);s.close();
});
