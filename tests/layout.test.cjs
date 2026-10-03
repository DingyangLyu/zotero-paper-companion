const {test}=require('node:test');const assert=require('node:assert/strict');const {JSDOM}=require('jsdom');const Layout=require('../plugin/content/layout.js');
test('pane height uses available pane space rather than whole application viewport',()=>{
 assert.equal(Layout.paneHeight(800,100,220),688);assert.equal(Layout.paneHeight(500,100,220),388);
 assert(Layout.paneHeight(260,0,240)>=336,'short panes must not crop fixed controls');assert.equal(Layout.paneHeight(0,0,200),null);
});
test('pane resize and scrolling update available space, and destroyed views stop observing',()=>{
 const dom=new JSDOM('<item-details><div class="zotero-view-item"><item-pane-custom-section><collapsible-section><div class="body"><div id="body"><div class="pc-root" style="row-gap:10px;padding:6px 2px"><div id="top"></div><div class="pc-chat"></div><div id="compose"></div></div></div></div></collapsible-section></item-pane-custom-section></div></item-details>');
 const win=dom.window,doc=win.document,body=doc.querySelector('#body'),root=doc.querySelector('.pc-root'),viewport=doc.querySelector('.zotero-view-item');let viewportHeight=800,offset=100,observeCallback,disconnected=false;const frames=new Map();let serial=0;
 win.setTimeout=fn=>{const id=++serial;frames.set(id,fn);return id;};win.clearTimeout=id=>frames.delete(id);win.ResizeObserver=class {constructor(fn){observeCallback=fn;}observe(){}disconnect(){disconnected=true;}};
 viewport.getBoundingClientRect=()=>({top:0,height:viewportHeight,width:300});root.getBoundingClientRect=()=>({top:offset,width:300});doc.querySelector('#top').getBoundingClientRect=()=>({height:90});doc.querySelector('#compose').getBoundingClientRect=()=>({height:110});
 const flush=()=>{for(const [id,fn] of [...frames]){frames.delete(id);fn();}};
 const v={win,body,root,destroyed:false},cleanup=Layout.attach(v);flush();assert.equal(root.style.getPropertyValue('--pc-pane-height'),'688px');assert(body.classList.contains('pc-pane-body'));
 viewportHeight=500;observeCallback();flush();assert.equal(root.style.getPropertyValue('--pc-pane-height'),'388px');offset=50;viewport.dispatchEvent(new win.Event('scroll'));flush();assert.equal(root.style.getPropertyValue('--pc-pane-height'),'438px');
 observeCallback();cleanup();flush();assert(disconnected);assert.equal(frames.size,0);assert.equal(root.style.getPropertyValue('--pc-pane-height'),'');assert(!body.classList.contains('pc-pane-body'));assert(!doc.querySelector('item-pane-custom-section').classList.contains('pc-pane-section'));dom.window.close();
});
