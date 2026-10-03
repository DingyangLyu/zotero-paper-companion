var PaperCompanionPlugin = {
  windows:new Map(), views:new Map(), drafts:new Map(), paneID:null, initialized:false,
  async init({id,version,rootURI}) {
    this.id=id;this.version=version;this.rootURI=rootURI;
    this.styles=await Zotero.File.getResourceAsync(rootURI+'content/style.css');
    await PaperNative.discoverEngines();
    Zotero.PaperCompanion=this;
    this.selectionHandler=e=>this.selectionPopup(e);
    Zotero.Reader.registerEventListener('renderTextSelectionPopup',this.selectionHandler,id);
    this.paneID=Zotero.ItemPaneManager.registerSection({
      paneID:'paper-companion',pluginID:id,
      header:{l10nID:'pc-pane-header',icon:rootURI+'content/icon.svg'},
      sidenav:{l10nID:'pc-pane-sidenav',icon:rootURI+'content/icon.svg'},
      onInit:({doc})=>this.addToWindow(doc.defaultView),
      onItemChange:({tabType,setEnabled})=>setEnabled(tabType==='reader'),
      onRender:props=>this.render(props),
      onDestroy:({body})=>this.destroyView(body)
    });
    this.initialized=true;
  },
  addToAllWindows(){for(const win of Zotero.getMainWindows())this.addToWindow(win);},
  addToWindow(win) {
    if(!win?.ZoteroPane || this.windows.has(win))return;
    win.document.l10n?.addResourceIds(['paper-companion.ftl']);
    const style=win.document.createElementNS('http://www.w3.org/1999/xhtml','style');style.textContent=this.styles;win.document.documentElement.append(style);
    this.windows.set(win,{style});
  },
  removeFromWindow(win){this.popupUI?.removeFromWindow(win);for(const [body,v] of this.views)if(v.win===win)this.destroyView(body);this.windows.get(win)?.style.remove();win.document.l10n?.removeResourceIds(['paper-companion.ftl']);this.windows.delete(win);},
  element(doc,tag,cls,text) {const e=doc.createElementNS('http://www.w3.org/1999/xhtml',tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e;},
  button(doc,text,action,cls) {const b=this.element(doc,'button',cls,text);b.type='button';b.addEventListener('click',action);return b;},
  copyText(text){Cc['@mozilla.org/widget/clipboardhelper;1'].getService(Ci.nsIClipboardHelper).copyString(text);},
  render({doc,body}) {
    const reader=PaperNative.getReader(body);
    if(!reader || !Zotero.Items.get(reader.itemID)?.isPDFAttachment()){this.destroyView(body);body.textContent='请在 Zotero 标签页中打开 PDF。';return;}
    if(this.views.get(body)?.itemID===reader.itemID)return;
    this.destroyView(body);body.replaceChildren();
    const win=doc.defaultView;
    const v={doc,body,win,itemID:reader.itemID,tabID:reader.tabID,serial:0,history:[],loaded:false,quote:this.drafts.get(reader.itemID) || null,context:[],pageCount:0,busy:false,destroyed:false,controller:null,engineID:Zotero.Prefs.get(PaperNative.PREFIX+'defaultEngine',true) || 'codex'};
    const root=this.element(doc,'div','pc-root');v.root=root;
    const heading=this.element(doc,'div','pc-heading');
    v.title=this.element(doc,'div','pc-paper-title','论文助手');
    const top=this.element(doc,'div','pc-top');
    v.engines=this.element(doc,'select');v.engines.setAttribute('aria-label','选择引擎');
    for(const config of PaperNative.configs()){const o=this.element(doc,'option',null,config.name);o.value=config.id;v.engines.append(o);}v.engines.value=v.engineID;if(!v.engines.value)v.engines.value='codex';v.engineID=v.engines.value;
    v.model=this.element(doc,'input');v.model.placeholder='输入模型名称，留空沿用引擎默认';v.model.setAttribute('aria-label','自定义模型名称');
    v.model.value=PaperNative.configs().find(c=>c.id===v.engineID)?.model || '';
    v.settingsButton=this.button(doc,'配置',()=>this.settings(v),'pc-ghost');
    v.modelMenu=this.element(doc,'select');v.modelMenu.setAttribute('aria-label','选择模型');
    v.refreshModels=this.button(doc,'↻',()=>this.readModels(v),'pc-icon-button');v.refreshModels.title='读取本机 Codex 的可用模型';v.refreshModels.setAttribute('aria-label','刷新 Codex 模型');
    const field=(label,control)=>{const box=this.element(doc,'label','pc-field');box.append(this.element(doc,'span','pc-field-label',label));const wrap=this.element(doc,'span','pc-select-wrap');wrap.append(control);box.append(wrap);return box;};
    const engineRow=this.element(doc,'div','pc-control-row'),modelRow=this.element(doc,'div','pc-control-row');
    engineRow.append(field('引擎',v.engines),v.settingsButton);modelRow.append(field('模型',v.modelMenu),v.refreshModels);
    v.modelBox=this.element(doc,'label','pc-model-editor');v.modelBox.hidden=true;v.modelBox.append(this.element(doc,'span','pc-field-label','自定义模型'),v.model);
    top.append(engineRow,modelRow,v.modelBox);this.modelOptions(v);
    v.modelMenu.addEventListener('change',()=>{if(v.modelMenu.value==='__custom__'){v.modelBox.hidden=false;v.model.focus();return;}v.model.value=v.modelMenu.value;v.model.dispatchEvent(new v.win.Event('change',{bubbles:true}));});
    v.model.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();v.model.blur();}});
    v.settingsBox=this.element(doc,'div','pc-settings');v.settingsBox.hidden=true;
    v.selection=this.element(doc,'div','pc-selection');v.selection.setAttribute('aria-label','选中的论文原文');
    v.contextDetails=this.element(doc,'details','pc-context-details');const contextSummary=this.element(doc,'summary');v.contextMeta=this.element(doc,'span','pc-context-meta');contextSummary.append(this.element(doc,'span',null,'本次引用的上下文'),v.contextMeta);v.contextDetails.append(contextSummary);v.context=this.element(doc,'div','pc-context');v.contextDetails.append(v.context);this.paintContext(v);
    v.messages=this.element(doc,'div','pc-history');v.messages.setAttribute('aria-label','论文对话');
    v.input=this.element(doc,'textarea','pc-composer');v.input.placeholder='针对选区提问，或直接询问这篇论文…';v.input.setAttribute('aria-label','论文问题');
    v.input.addEventListener('keydown',e=>{if((e.metaKey || e.ctrlKey) && e.key==='Enter'){e.preventDefault();this.send(v,'qa');}});
    const compose=this.element(doc,'div','pc-compose'),actions=this.element(doc,'div','pc-actions');
    v.translate=this.button(doc,'翻译选区',()=>this.send(v,'translate'));
    v.ask=this.button(doc,'发送',()=>this.send(v,'qa'),'pc-primary');
    v.stop=this.button(doc,'停止',()=>v.controller?.abort());v.stop.disabled=true;
    v.clear=this.button(doc,'取消选区',()=>{v.quote=null;this.drafts.delete(v.itemID);this.paintSelection(v);});
    v.newChat=this.button(doc,'＋ 新对话',async()=>{if(v.busy)return;v.history=[];v.quote=null;this.drafts.delete(v.itemID);this.paintSelection(v);this.paintContext(v);this.paintHistory(v);if(v.identity)try{await PaperNative.saveHistory(v.identity.key,v.engineID,v.history);}catch(e){this.status(v,e.message,true);}},'pc-ghost');
    heading.append(v.title,v.newChat);
    actions.append(v.translate,v.clear,this.element(doc,'span','pc-action-spacer'),v.stop,v.ask);compose.append(v.input,actions);v.ask.title='发送（⌘ / Ctrl + Enter）';
    v.status=this.element(doc,'div','pc-status');v.status.setAttribute('role','status');
    const chat=this.element(doc,'div','pc-chat');chat.append(v.contextDetails,v.messages);
    root.append(heading,top,v.settingsBox,v.selection,v.status,chat,compose);body.append(root);this.views.set(body,v);v.layoutCleanup=PaperLayout.attach(v);
    v.engines.addEventListener('change',()=>{if(v.busy)return;v.engineID=v.engines.value;v.model.value=PaperNative.configs().find(c=>c.id===v.engineID)?.model || '';Zotero.Prefs.set(PaperNative.PREFIX+'defaultEngine',v.engineID,true);this.paintContext(v);this.modelOptions(v);this.load(v);});
    v.model.addEventListener('change',()=>{const configs=PaperNative.configs();const c=configs.find(c=>c.id===v.engineID);if(c){c.model=v.model.value.trim();c.modelEffort=c.models?.find(m=>m.id===c.model)?.effort || '';PaperNative.saveConfigs(configs);this.modelOptions(v);}});
    this.paintSelection(v);this.paintHistory(v);this.load(v).then(()=>{if(this.pendingSelection?.tabID===v.tabID&&this.current(v)){const kind=this.pendingSelection.kind;this.pendingSelection=null;if(kind==='settings')this.settings(v);else{v.input.value='请解释所选内容，说明它在论文中的含义。';v.input.focus();}}});
  },
  current(v) {return !v.destroyed && !v.win.closed && this.views.get(v.body)===v && Zotero.Reader.getByTabID(v.tabID)?.itemID===v.itemID;},
  async load(v) {
    const serial=++v.serial;const id=v.engineID;v.loaded=false;this.busyControls(v);
    try{const identity=await PaperNative.paperIdentity(v.itemID);const history=await PaperNative.loadHistory(identity.key,id);if(!this.current(v)||serial!==v.serial||id!==v.engineID)return;v.identity=identity;v.history=history;v.loaded=true;v.title.textContent=identity.title;v.title.title=identity.title;this.paintHistory(v);this.busyControls(v);this.status(v,'就绪');}
    catch(e){if(this.current(v))this.status(v,e.message,true);}
  },
  status(v,text,error=false){if(v.destroyed)return;v.status.textContent=PaperCore.redact(text).slice(0,1200);v.status.dataset.error=String(error);v.status.hidden=!error&&(text==='就绪'||text.startsWith('完成 ·'));},
  paintSelection(v) {v.selection.textContent=v.quote?`PDF 第 ${v.quote.pageIndex+1} 页${v.quote.pageLabel!==String(v.quote.pageIndex+1)?'（文献页码 '+v.quote.pageLabel+'）':''} · 选区\n${v.quote.text}`:'';v.translate.hidden=v.clear.hidden=!v.quote;v.translate.disabled=v.busy || !v.loaded || !v.quote;v.clear.disabled=v.busy || !v.quote;},
  paintContext(v,blocks=[]) {
    v.context.replaceChildren();v.contextBlocks=blocks;
    const pages=[...new Set(blocks.map(b=>b.pageIndex+1))];v.contextMeta.textContent=blocks.length?`${blocks.length} 段 · ${pages.length} 页`:'未引用';
    if(!blocks.length){v.contextDetails.open=false;v.context.append(this.element(v.doc,'p','pc-muted','本轮尚未引用论文段落。'));return;}
    for(const block of blocks){const article=this.element(v.doc,'div','pc-context-block');const jump=this.button(v.doc,'PDF 第 '+(block.pageIndex+1)+' 页',()=>{if(this.current(v))Zotero.Reader.getByTabID(v.tabID).navigate({pageIndex:block.pageIndex});},'pc-context-page');article.append(jump,this.element(v.doc,'p',null,block.text));v.context.append(article);}
  },
  paintHistory(v) {
    v.messages.replaceChildren();
    if(!v.history.length){v.messages.append(this.element(v.doc,'div','pc-empty','在论文中划选一个词、一句话或一段文字，然后点击“翻译”或“提问”。\n也可以直接在这里询问论文内容。'));return;}
    for(const message of v.history){const article=this.element(v.doc,'article','pc-message');article.dataset.role=message.role;
      const header=this.element(v.doc,'header',null,message.role==='user'?'你':(message.engineName || '论文助手')+(message.status==='partial'?' · 已停止':message.status==='error'?' · 未完成':''));if(message.role==='assistant'&&message.model)header.append(this.element(v.doc,'span','pc-message-model',message.model));article.append(header);
      const content=this.element(v.doc,'div');this.drawMessage(v,content,message);article.append(content);v.messages.append(article);
    }
    v.messages.scrollTop=v.messages.scrollHeight;
  },
  drawMessage(v,node,message){PaperRender.render(v.doc,node,message.text || '',{pageCount:message.pageCount || v.pageCount,sources:message.sources || [],onPage:pageIndex=>{if(this.current(v))Zotero.Reader.getByTabID(v.tabID).navigate({pageIndex});},onExternal:url=>Zotero.launchURL(url)});},
  async send(v,kind) {
    if(v.busy || v.detectingModels || !this.current(v))return;
    if(!v.loaded){this.status(v,'正在恢复当前论文的对话，请稍候');return;}
    const question=v.input.value.trim();const quote=v.quote?JSON.parse(JSON.stringify(v.quote)):null;
    if(kind==='translate'&&!quote){this.status(v,'请先在 PDF 中选择文字',true);return;}
    if(kind==='qa'&&!question&&!quote){this.status(v,'请输入问题或选择原文',true);return;}
    const requestedEngine=v.engineID;
    let config=await PaperNative.ensureCLIConfig(requestedEngine) || PaperNative.configs().find(c=>c.id===v.engineID);
    if(!this.current(v)||v.busy||requestedEngine!==v.engineID)return;
    if(!config)return;
    config.model=v.model.value.trim();
    if(config.id==='codex'&&config.path&&!config.model){
      v.detectingModels=true;v.modelController=new v.win.AbortController();this.busyControls(v);this.status(v,'正在读取 Codex 可用模型…');
      try{config=await PaperNative.ensureCodexModel(config,{signal:v.modelController.signal});if(!this.current(v)||requestedEngine!==v.engineID)return;v.model.value=config.model;this.modelOptions(v);}
      catch(e){this.status(v,e.message,true);return;}finally{v.detectingModels=false;v.modelController=null;this.busyControls(v);}
    }
    if(config.type==='cli'&&!config.path){this.status(v,'请点击“配置”，选择本机 '+config.name+' 可执行文件',true);this.settings(v);return;}
    if(config.type==='api'){try{PaperEngines.endpoint(config);if(!config.model)throw new Error('请配置 API 模型');}catch(e){this.status(v,e.message,true);this.settings(v);return;}}
    v.busy=true;v.controller=new v.win.AbortController();this.busyControls(v);this.status(v,'正在读取论文上下文…');
    let responseNode,response,appended=false;
    const timeout=v.win.setTimeout(()=>v.controller?.abort(),300000);
    try {
      const identity=await PaperNative.paperIdentity(v.itemID);const paper=await PaperNative.readPaper(identity,v.win,v.controller.signal);
      if(!this.current(v)||v.controller.signal.aborted)throw new Error('已停止');
      v.identity=identity;v.pageCount=paper.pageCount;
      let blocks;
      if(quote){const context=PaperCore.contextFor(paper.blocks,quote,Zotero.Prefs.get(PaperNative.PREFIX+'contextRadius',true));blocks=context.blocks;if(!context.found){this.status(v,'未定位到选区段落，仅使用所选原文；请核对选区或 PDF 文本层');blocks=[{text:quote.text,pageIndex:quote.pageIndex}];}}
      else blocks=PaperCore.retrieve(paper.blocks,question);
      this.paintContext(v,blocks);
      const messages=PaperCore.messages({kind,question:question || '请解释这段原文',quote,blocks,title:identity.title,language:Zotero.Prefs.get(PaperNative.PREFIX+'language',true),history:v.history});
      const sources=[...new Set(blocks.map(b=>b.pageIndex+1))];
      v.history.push({role:'user',text:kind==='translate'?`翻译：${quote.text}`:(quote?`> ${quote.text}\n\n`:'')+(question || '解释选区'),status:'complete',sources,pageCount:paper.pageCount});
      response={role:'assistant',text:'',status:'pending',engineName:config.name,model:config.model || '',sources,pageCount:paper.pageCount};v.history.push(response);appended=true;v.input.value='';this.paintHistory(v);responseNode=v.messages.lastElementChild.lastElementChild;
      this.status(v,'正在使用 '+config.name+(config.model?' · '+config.model:'')+'…');
      const options={signal:v.controller.signal,onText:text=>{response.text=text;if(this.current(v))this.scheduleMessage(v,responseNode,response);},fetch:v.win.fetch.bind(v.win),TextDecoder:v.win.TextDecoder};
      const result=config.type==='api'?await PaperEngines.runAPI(config,messages,{...options,key:await PaperNative.keyFor(config.id)}):await PaperEngines.runCLI(config,messages,{...options,workdir:await PaperNative.workdir(identity.key),path:await this.runtimePath(config)});
      response.text=result;response.status='complete';this.status(v,'完成 · 引用 '+sources.length+' 页');
      v.quote=null;this.drafts.delete(v.itemID);
    } catch(e) {if(response)response.status=v.controller?.signal.aborted?'partial':'error';this.status(v,/not supported when using Codex with a ChatGPT account/.test(e.message)?'当前模型不受本机 Codex 账号支持。请点击“刷新模型”，从目录选择可用模型。':e.message,true);}
    finally {
      v.win.clearTimeout(timeout);if(v.renderTimer){v.win.clearTimeout(v.renderTimer);v.renderTimer=null;}
      if(response&&this.current(v))this.drawMessage(v,responseNode,response);
      v.busy=false;v.controller=null;this.busyControls(v);this.paintSelection(v);
      if(appended&&v.identity)try{await PaperNative.saveHistory(v.identity.key,config.id,v.history);}catch(e){this.status(v,'回答已生成，但本地保存失败：'+e.message,true);}
    }
  },
  scheduleMessage(v,node,message){if(v.renderTimer)return;v.renderTimer=v.win.setTimeout(()=>{v.renderTimer=null;if(this.current(v)){const selection=v.win.getSelection();if(selection&&!selection.isCollapsed&&v.messages.contains(selection.anchorNode))return;const nearBottom=v.messages.scrollHeight-v.messages.scrollTop-v.messages.clientHeight<100;this.drawMessage(v,node,message);if(nearBottom)v.messages.scrollTop=v.messages.scrollHeight;}},60);},
  async runtimePath(config) {const nodes=await PaperNative.executablePaths('node');return [PathUtils.parent(config.path),...nodes.map(p=>PathUtils.parent(p)),Services.env.get('PATH'),'/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin'].filter(Boolean).join(':');},
  busyControls(v){for(const e of [v.engines,v.model,v.modelMenu,v.refreshModels,v.settingsButton,v.ask,v.newChat])e.disabled=v.busy || v.detectingModels || (!v.loaded && e!==v.settingsButton);v.stop.hidden=!v.busy;v.ask.hidden=v.busy;v.stop.disabled=!v.busy;v.root.setAttribute('aria-busy',String(v.busy));this.paintSelection(v);},
  modelOptions(v) {
    if(!v.modelMenu)return;
    const config=PaperNative.configs().find(c=>c.id===v.engineID),codex=v.engineID==='codex';
    v.modelMenu.hidden=false;v.refreshModels.hidden=!codex;v.modelMenu.replaceChildren();v.modelBox.hidden=true;
    const initial=this.element(v.doc,'option',null,'引擎默认');initial.value='';v.modelMenu.append(initial);
    for(const model of config?.models || []){const option=this.element(v.doc,'option',null,model.name+'（'+model.id+'）');option.value=model.id;v.modelMenu.append(option);}
    if(v.model.value&&!config?.models?.some(m=>m.id===v.model.value)){const option=this.element(v.doc,'option',null,v.model.value);option.value=v.model.value;v.modelMenu.append(option);}
    const custom=this.element(v.doc,'option',null,'自定义模型…');custom.value='__custom__';v.modelMenu.append(custom);v.modelMenu.value=v.model.value;
    v.modelMenu.title=v.model.value || '沿用 '+(config?.name || '当前引擎')+' 自身配置中的默认模型';
  },
  async readModels(v) {
    if(v.busy||v.detectingModels||!this.current(v)||v.engineID!=='codex')return;
    v.detectingModels=true;v.modelController=new v.win.AbortController();this.busyControls(v);this.status(v,'正在读取 Codex 模型目录…');
    try{
      const config=await PaperNative.ensureCLIConfig('codex');if(!config?.path)throw Error('没有检测到本机 Codex，请在配置中选择路径');
      const result=await PaperNative.ensureCodexModel(config,{refresh:true,signal:v.modelController.signal});
      if(this.current(v)&&v.engineID==='codex'){v.model.value=result.model;this.modelOptions(v);this.status(v,'已读取 '+result.models.length+' 个可选模型');}
    }catch(e){if(this.current(v))this.status(v,e.message,true);}finally{v.detectingModels=false;v.modelController=null;this.busyControls(v);}
  },
  selectionPopup({reader,doc,params,append}) {
    if(!reader.tabID || Zotero.Reader.getByTabID(reader.tabID)?.itemID!==reader.itemID)return;
    const quote=PaperCore.selection(params.annotation,reader.itemID);if(!quote)return;
    const action=settings=>{
      if(Zotero.Reader.getByTabID(reader.tabID)?.itemID!==quote.itemID)return;
      this.drafts.set(quote.itemID,quote);
      const views=[...this.views.values()].filter(v=>v.itemID===quote.itemID&&v.tabID===reader.tabID);
      for(const v of views){if(v.busy)continue;v.quote=quote;this.paintSelection(v);if(settings){if(v.settingsBox.hidden)this.settings(v);}else{v.input.value='请解释所选内容，说明它在论文中的含义。';v.input.focus();}}
      if(!views.length)this.pendingSelection={tabID:reader.tabID,kind:settings?'settings':'qa'};
      this.openPane(reader);
    };
    this.popupUI ||= new PaperPopup(this);
    this.popupUI.create({reader,doc,quote,append,onQA:()=>action(false),onSettings:()=>action(true)});
  },
  openPane(reader) {
    // item-details is Zotero's native pane host; tab mapping is rechecked before
    // opening it. Capability-gated fallback, verified only on Zotero 10.0.4.
    for(const win of Zotero.getMainWindows()){
      const details=[...win.document.querySelectorAll('item-details')].find(e=>e.tabID===reader.tabID || e.dataset.tabId===reader.tabID);
      if(details){const parent=details.closest('context-pane, item-pane');if(parent&&'collapsed' in parent&&parent.collapsed)parent.collapsed=false;if(typeof details.scrollToPane==='function')details.scrollToPane(this.paneID,'instant');else{const button=[...(details.sidenav?.querySelectorAll('[data-pane]') || [])].find(e=>e.dataset.pane===this.paneID);button?.click();}return;}
    }
  },
  settings(v) {
    if(v.busy)return;
    if(!v.settingsBox.hidden){v.settingsBox.hidden=true;return;}
    v.settingsBox.hidden=false;v.settingsBox.replaceChildren();
    const doc=v.doc, configs=PaperNative.configs();let selected=configs.find(c=>c.id===v.engineID);
    const heading=this.element(doc,'div','pc-title','引擎与模型配置');v.settingsBox.append(heading);
    v.settingsBox.append(this.button(doc,'重新检测本机引擎',async()=>{try{await PaperNative.discoverEngines();if(this.current(v)){v.settingsBox.hidden=true;this.settings(v);this.status(v,'本机引擎检测完成');}}catch(e){this.status(v,e.message,true);}}));
    const chooser=this.element(doc,'select');chooser.setAttribute('aria-label','配置哪个引擎');for(const c of configs){const o=this.element(doc,'option',null,c.name);o.value=c.id;chooser.append(o);}chooser.value=selected.id;v.settingsBox.append(chooser);
    const fields=this.element(doc,'div');v.settingsBox.append(fields);
    const addField=(label,value,type='text')=>{const l=this.element(doc,'label',null,label);const i=this.element(doc,'input');i.type=type;i.value=value || '';l.append(i);fields.append(l);return i;};
    const draw=()=>{
      fields.replaceChildren();selected=configs.find(c=>c.id===chooser.value);
      const name=addField('显示名称',selected.name);
      const model=addField('模型名称（本地引擎可留空）',selected.model);
      let path,url,protocol,key;
      if(selected.type==='cli'){
        path=addField('可执行文件的绝对路径',selected.path);
        const candidates=this.element(doc,'select');candidates.setAttribute('aria-label','本机候选路径');candidates.append(this.element(doc,'option',null,'选择本机路径…'));fields.append(candidates);
        PaperNative.executablePaths(selected.id).then(list=>{if(v.destroyed||!fields.contains(candidates))return;for(const p of list){const o=this.element(doc,'option',null,p);o.value=p;candidates.append(o);}});
        candidates.addEventListener('change',()=>{if(candidates.selectedIndex>0)path.value=candidates.value;});
        fields.append(this.button(doc,'浏览文件',async()=>{const {FilePicker}=ChromeUtils.importESModule('chrome://zotero/content/modules/filePicker.mjs');const picker=new FilePicker();picker.init(v.win,'选择 '+selected.name,picker.modeOpen);const result=await picker.show();if(result===picker.returnOK&&this.current(v)&&fields.contains(path))path.value=picker.file;}));
      }else{
        url=addField('API Base URL（例如 https://api.example.com/v1）',selected.baseURL);
        const l=this.element(doc,'label',null,'API 协议');protocol=this.element(doc,'select');for(const [id,title] of [['openai','OpenAI Chat Completions 兼容'],['responses','OpenAI Responses'],['anthropic','Anthropic Messages']]){const o=this.element(doc,'option',null,title);o.value=id;protocol.append(o);}protocol.value=selected.protocol || 'openai';l.append(protocol);fields.append(l);
        key=addField('API Key（留空保留现有密钥）','','password');key.autocomplete='off';
      }
      const apply=this.button(doc,'保存配置',async()=>{
        try{
          const next={...selected,name:name.value.trim() || selected.name,model:model.value.trim()};
          if(path){if(!PathUtils.isAbsolute(path.value.trim()))throw new Error('请选择可执行文件的绝对路径');next.path=path.value.trim();}
          if(url){next.baseURL=url.value.trim();next.protocol=protocol.value;PaperEngines.endpoint(next);}
          const index=configs.findIndex(c=>c.id===selected.id);configs[index]=next;PaperNative.saveConfigs(configs);if(key?.value.trim()){await PaperNative.saveKey(next.id,key.value.trim());key.value='';}
          v.engines.replaceChildren();for(const c of configs){const o=this.element(doc,'option',null,c.name);o.value=c.id;v.engines.append(o);}v.engines.value=v.engineID;v.model.value=configs.find(c=>c.id===v.engineID)?.model || '';this.modelOptions(v);this.status(v,'配置已保存');
        }catch(e){this.status(v,e.message,true);}
      },'pc-primary');fields.append(apply);
      if(key)fields.append(this.button(doc,'清除已保存的 API Key',async()=>{await PaperNative.saveKey(selected.id,'');this.status(v,'已清除当前接口的密钥');}));
    };chooser.addEventListener('change',draw);draw();
    v.settingsBox.append(this.button(doc,'添加自定义 API',()=>{const c={id:'api-'+Services.uuid.generateUUID().toString().replace(/[{}]/g,''),name:'自定义 API',type:'api',model:'',protocol:'openai',baseURL:''};configs.push(c);const o=this.element(doc,'option',null,c.name);o.value=c.id;chooser.append(o);chooser.value=c.id;draw();}));
    const languageLabel=this.element(doc,'label',null,'回答 / 翻译语言');const language=this.element(doc,'input');language.value=Zotero.Prefs.get(PaperNative.PREFIX+'language',true) || '简体中文';language.addEventListener('change',()=>Zotero.Prefs.set(PaperNative.PREFIX+'language',language.value.trim() || '简体中文',true));languageLabel.append(language);
    const radiusLabel=this.element(doc,'label',null,'附近段落');const radius=this.element(doc,'select');for(const n of [1,2]){const o=this.element(doc,'option',null,'选区所在段落 + 前后各 '+n+' 段');o.value=String(n);radius.append(o);}radius.value=String(Zotero.Prefs.get(PaperNative.PREFIX+'contextRadius',true) || 1);radius.addEventListener('change',()=>Zotero.Prefs.set(PaperNative.PREFIX+'contextRadius',Number(radius.value),true));radiusLabel.append(radius);v.settingsBox.append(languageLabel,radiusLabel,this.element(doc,'div','pc-muted','本地引擎使用它自身的登录与 API 配置。自定义接口密钥保存于 Zotero 的 Login Manager，不写进聊天记录。'));
  },
  destroyView(body){const v=this.views.get(body);if(!v)return;v.destroyed=true;v.serial++;v.controller?.abort();v.modelController?.abort();v.layoutCleanup?.();if(v.renderTimer)v.win.clearTimeout(v.renderTimer);this.views.delete(body);},
  async shutdown(){this.popupUI?.shutdown();this.popupUI=null;for(const body of [...this.views.keys()])this.destroyView(body);if(this.paneID)Zotero.ItemPaneManager.unregisterSection(this.paneID);Zotero.Reader.unregisterEventListener('renderTextSelectionPopup',this.selectionHandler);for(const win of [...this.windows.keys()])this.removeFromWindow(win);this.drafts.clear();if(Zotero.PaperCompanion===this)delete Zotero.PaperCompanion;this.initialized=false;}
};
