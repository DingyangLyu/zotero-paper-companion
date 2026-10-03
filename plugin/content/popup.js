(function(g) {
  'use strict';
  // Each selection owns its request. Closing/replacing it cancels the process,
  // and every async boundary rechecks the reader before touching its DOM.
  class SelectionTranslation {
    constructor(plugin) {
      this.plugin=plugin;this.states=new Map();this.cache=new Map();
      this.observerID=g.Zotero.Notifier?.registerObserver({notify:(event,type,ids)=>{
        for(const state of [...this.states.values()])if((event==='close'&&ids.includes(state.tabID))||!this.current(state))this.dispose(state);
      }},['tab'],'paper-companion-popup');
    }
    current(s) {
      return !s.disposed&&!s.win.closed&&this.states.get(s.tabID)===s&&
        g.Zotero.Reader.getByTabID(s.tabID)?.itemID===s.quote.itemID&&
        (!s.owner?.Zotero_Tabs||s.owner.Zotero_Tabs.selectedID===s.tabID);
    }
    alive(s) {return this.current(s)&&s.root.isConnected;}
    create({reader,doc,quote,append,onQA,onSettings}) {
      this.dispose(this.states.get(reader.tabID));
      const p=this.plugin,win=doc.defaultView;
      const s={tabID:reader.tabID,quote,doc,win,owner:g.Zotero.getMainWindows().find(w=>[...w.document.querySelectorAll('item-details')].some(d=>d.tabID===reader.tabID)),disposed:false,busy:false,text:'',sources:[],pageCount:0};
      this.states.set(s.tabID,s);
      s.root=p.element(doc,'section','pc-inline');s.root.setAttribute('aria-label','论文选区翻译');
      const style=p.element(doc,'style');style.textContent=p.styles || '';s.root.append(style);
      const toolbar=p.element(doc,'div','pc-inline-toolbar');
      s.translate=p.button(doc,'翻译',()=>{s.running=this.translate(s,{refresh:!!s.text});},'pc-primary');
      s.qa=p.button(doc,'提问',onQA);
      s.engines=p.element(doc,'select');s.engines.setAttribute('aria-label','弹窗翻译引擎');
      for(const c of g.PaperNative.configs()){const option=p.element(doc,'option',null,c.name);option.value=c.id;s.engines.append(option);}
      s.engines.value=g.Zotero.Prefs.get(g.PaperNative.PREFIX+'defaultEngine',true) || 'codex';
      if(!s.engines.value)s.engines.value='codex';s.engineID=s.engines.value;
      s.engines.addEventListener('change',()=>{s.engineID=s.engines.value;g.Zotero.Prefs.set(g.PaperNative.PREFIX+'defaultEngine',s.engineID,true);s.text='';s.output.replaceChildren();s.details.hidden=true;s.translate.textContent='翻译';s.copy.disabled=true;this.status(s,'点击翻译，译文会显示在这里');this.modelLabel(s);});
      const settings=p.button(doc,'配置',onSettings);toolbar.append(s.translate,s.qa,s.engines,settings);
      s.model=p.element(doc,'div','pc-inline-model');this.modelLabel(s);
      s.status=p.element(doc,'div','pc-inline-status');s.status.setAttribute('role','status');s.status.setAttribute('aria-live','polite');
      s.output=p.element(doc,'div','pc-inline-output pc-message');s.output.setAttribute('aria-label','译文');
      s.details=p.element(doc,'details','pc-inline-context');s.details.hidden=true;s.details.append(p.element(doc,'summary',null,'原文与引用上下文'));s.context=p.element(doc,'div');s.details.append(s.context);
      const footer=p.element(doc,'div','pc-inline-footer');s.copy=p.button(doc,'复制译文',()=>{if(!s.text)return;try{p.copyText(s.text);this.status(s,'译文已复制');}catch(e){this.status(s,e.message,true);}});s.copy.disabled=true;
      s.stop=p.button(doc,'停止',()=>s.controller?.abort());s.stop.hidden=true;footer.append(s.copy,s.stop);
      s.root.append(toolbar,s.model,s.status,s.output,s.details,footer);
      // The reader's PDF selection handlers must not receive clicks or drags
      // inside the translation; native selection/copy in the result still works.
      for(const event of ['pointerdown','pointerup','mousedown','mouseup','dblclick','keydown','dragstart'])s.root.addEventListener(event,e=>e.stopPropagation());
      s.unload=()=>this.dispose(s);win.addEventListener('unload',s.unload,{once:true});
      s.observer=new win.MutationObserver(()=>{
        if(s.root.isConnected){s.connected=true;if(!this.current(s))this.dispose(s);}
        else if(s.connected)this.dispose(s);
      });s.observer.observe(doc.documentElement,{childList:true,subtree:true});
      append(s.root);s.connected=s.root.isConnected;
      s.attachTimer=win.setTimeout(()=>{if(!s.root.isConnected)this.dispose(s);},1000);
      this.status(s,'点击翻译，译文会显示在这里');
      // Native Zotero positions the popup before streamed content arrives.
      // Keep a growing result within the same reader viewport.
      if(win.ResizeObserver){s.resize=new win.ResizeObserver(()=>this.fit(s));s.resize.observe(s.root);}
      return s;
    }
    fit(s) {
      if(!this.alive(s))return;
      const host=s.root.closest('.selection-popup');if(!host)return;
      const rect=host.getBoundingClientRect(),bounds=host.parentElement.getBoundingClientRect();
      const right=Math.min(bounds.right,s.win.innerWidth)-8,bottom=Math.min(bounds.bottom,s.win.innerHeight)-8;
      const dx=rect.right>right?right-rect.right:rect.left<bounds.left+8?bounds.left+8-rect.left:0;
      const dy=rect.bottom>bottom?bottom-rect.bottom:rect.top<bounds.top+8?bounds.top+8-rect.top:0;
      // Zotero 10.0.4 uses a CSS translate, not left/top, for ViewPopup.
      const position=host.style.transform.match(/^translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)$/);
      if((dx||dy)&&position){s.position ||= {host,original:host.style.transform};host.style.transform=`translate(${Number(position[1])+dx}px, ${Number(position[2])+dy}px)`;s.position.written=host.style.transform;}
    }
    modelLabel(s,config) {const c=config || g.PaperNative.configs().find(c=>c.id===s.engineID);s.model.textContent=(c?.name || '引擎')+(c?.model?' · '+c.model:' · 默认模型');}
    status(s,text,error=false){if(s.disposed)return;s.status.textContent=g.PaperCore.redact(text).slice(0,1200);s.status.dataset.error=String(error);}
    controls(s) {s.translate.disabled=s.busy;s.engines.disabled=s.busy;s.copy.disabled=!s.text;s.stop.hidden=!s.busy;s.root.setAttribute('aria-busy',String(s.busy));}
    draw(s) {
      if(!this.alive(s))return;
      g.PaperRender.render(s.doc,s.output,s.text,{pageCount:s.pageCount,sources:s.sources,onPage:pageIndex=>{if(this.current(s))g.Zotero.Reader.getByTabID(s.tabID).navigate({pageIndex});},onExternal:url=>g.Zotero.launchURL(url)});
      this.fit(s);
    }
    check(s,signal) {if(signal.aborted||!this.alive(s))throw Error('已停止');}
    async translate(s,{refresh=false}={}) {
      if(s.busy||!this.alive(s))return;
      s.busy=true;s.controller=new s.win.AbortController();const controller=s.controller,signal=controller.signal;
      s.text='';s.output.replaceChildren();this.controls(s);this.status(s,'正在读取附近段落…');
      const timer=s.win.setTimeout(()=>controller.abort(),300000);
      try{
        let config=await g.PaperNative.ensureCLIConfig(s.engineID);this.check(s,signal);
        if(!config)throw Error('当前引擎不存在，请点击“配置”');
        config={...config};
        if(config.type==='cli'&&!config.path)throw Error('未找到 '+config.name+'，请点击“配置”选择可执行文件');
        if(config.id==='codex'&&!config.model){this.status(s,'正在读取 Codex 可用模型…');config=await g.PaperNative.ensureCodexModel(config,{signal});this.check(s,signal);}
        if(config.type==='api'){g.PaperEngines.endpoint(config);if(!config.model)throw Error('请点击“配置”填写 API 模型');}
        this.modelLabel(s,config);
        const identity=await g.PaperNative.paperIdentity(s.quote.itemID);this.check(s,signal);
        const paper=await g.PaperNative.readPaper(identity,s.win,signal);this.check(s,signal);
        const radius=g.Zotero.Prefs.get(g.PaperNative.PREFIX+'contextRadius',true),language=g.Zotero.Prefs.get(g.PaperNative.PREFIX+'language',true);
        const context=g.PaperCore.contextFor(paper.blocks,s.quote,radius);
        const blocks=context.found?context.blocks:[{text:s.quote.text,pageIndex:s.quote.pageIndex}];
        s.sources=[...new Set(blocks.map(b=>b.pageIndex+1))];s.pageCount=paper.pageCount;s.context.replaceChildren();s.details.hidden=false;
        s.context.append(this.plugin.element(s.doc,'p','pc-inline-quote','选区：'+s.quote.text));
        for(const b of blocks)s.context.append(this.plugin.element(s.doc,'p',null,`[p.${b.pageIndex+1}] ${b.text}`));
        const key=JSON.stringify([identity.key,identity.hash,config.id,config.type,config.path,config.baseURL,config.protocol,config.model,config.modelEffort,language,s.quote.pageIndex,s.quote.text,s.quote.rects,blocks]);
        if(!refresh&&this.cache.has(key)){s.text=this.cache.get(key);this.cache.delete(key);this.cache.set(key,s.text);this.draw(s);this.status(s,'已显示本次阅读中缓存的译文');return;}
        const messages=g.PaperCore.messages({kind:'translate',quote:s.quote,blocks,title:identity.title,language});
        this.status(s,'正在翻译…'+(context.found?'':' 未定位到段落，仅使用选区原文'));
        const onText=text=>{if(!this.alive(s)||signal.aborted)return;s.text=text;if(!s.renderTimer)s.renderTimer=s.win.setTimeout(()=>{s.renderTimer=null;this.draw(s);this.controls(s);},60);};
        let options={signal,onText};
        if(config.type==='api'){const secret=await g.PaperNative.keyFor(config.id);this.check(s,signal);options={...options,key:secret,fetch:s.win.fetch.bind(s.win),TextDecoder:s.win.TextDecoder};}
        else{const workdir=await g.PaperNative.workdir(identity.key);this.check(s,signal);const path=await this.plugin.runtimePath(config);this.check(s,signal);options={...options,workdir,path};}
        const result=config.type==='api'?await g.PaperEngines.runAPI(config,messages,options):await g.PaperEngines.runCLI(config,messages,options);
        this.check(s,signal);if(!result?.trim())throw Error('引擎没有返回译文');s.text=result;this.draw(s);
        this.cache.set(key,result);
        while(this.cache.size>40||[...this.cache.values()].reduce((n,t)=>n+t.length,0)>1000000)this.cache.delete(this.cache.keys().next().value);
        this.status(s,context.found?'翻译完成 · 已参考附近段落':'翻译完成 · 未定位到段落，仅使用选区原文');
      }catch(e){if(this.current(s))this.status(s,signal.aborted?'已停止'+(s.text?' · 保留已生成内容':''):e.message,!signal.aborted);}
      finally{
        s.win.clearTimeout(timer);if(s.renderTimer){s.win.clearTimeout(s.renderTimer);s.renderTimer=null;}
        if(this.alive(s)){this.draw(s);s.translate.textContent=s.text?'重新翻译':'翻译';}
        s.busy=false;s.controller=null;if(!s.disposed)this.controls(s);
      }
    }
    dispose(s) {
      if(!s||s.disposed)return;s.disposed=true;s.controller?.abort();s.observer?.disconnect();s.resize?.disconnect();s.win.removeEventListener('unload',s.unload);s.win.clearTimeout(s.attachTimer);s.win.clearTimeout(s.renderTimer);
      if(s.position){const {host,original,written}=s.position;if(host.style.transform===written)host.style.transform=original;}
      s.root.remove();if(this.states.get(s.tabID)===s)this.states.delete(s.tabID);
    }
    removeFromWindow(win) {for(const s of [...this.states.values()])if(s.owner===win||s.win===win)this.dispose(s);}
    shutdown() {for(const s of [...this.states.values()])this.dispose(s);this.cache.clear();if(this.observerID!=null)g.Zotero.Notifier.unregisterObserver(this.observerID);}
  }
  g.PaperPopup=SelectionTranslation;if(typeof module!=='undefined')module.exports=SelectionTranslation;
})(globalThis);
