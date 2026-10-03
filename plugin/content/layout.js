(function(g) {
  'use strict';
  function paneHeight(viewportHeight,offsetTop,fixedHeight) {
    if(!Number.isFinite(viewportHeight)||viewportHeight<=0)return null;
    const minimum=Math.max(260,Math.ceil(fixedHeight+96));
    const available=viewportHeight-Math.max(0,offsetTop)-12;
    // Offscreen sections retain a useful height until Zotero scrolls them into
    // view. On short panes, Zotero's outer scroller keeps the composer reachable.
    return Math.round(Math.max(minimum,available<minimum?Math.min(560,viewportHeight-12):available));
  }
  function attach(v) {
    const win=v.win,body=v.body,root=v.root,host=body.closest('item-pane-custom-section');
    const viewport=body.closest('.zotero-view-item') || body.closest('item-details');
    body.classList.add('pc-pane-body');host?.classList.add('pc-pane-section');
    let disposed=false,frame=null;
    const update=()=>{
      frame=null;if(disposed||v.destroyed||!root.isConnected||!viewport)return;
      const bounds=viewport.getBoundingClientRect(),rect=root.getBoundingClientRect();if(bounds.height<=0||rect.width<=0)return;
      const style=win.getComputedStyle(root),children=[...root.children].filter(e=>!e.hidden&&win.getComputedStyle(e).display!=='none');
      const fixed=children.filter(e=>!e.classList.contains('pc-chat')).reduce((n,e)=>n+e.getBoundingClientRect().height,0)+Math.max(0,children.length-1)*(parseFloat(style.rowGap)||0)+(parseFloat(style.paddingTop)||0)+(parseFloat(style.paddingBottom)||0);
      const height=paneHeight(viewport.clientHeight || bounds.height,rect.top-bounds.top,fixed);
      if(height!=null&&root.style.getPropertyValue('--pc-pane-height')!==height+'px')root.style.setProperty('--pc-pane-height',height+'px');
    };
    const schedule=()=>{if(disposed||frame!=null)return;frame=win.setTimeout(update,0);};
    let observer;
    if(typeof win.ResizeObserver==='function'){
      observer=new win.ResizeObserver(schedule);for(const node of new Set([body,viewport,...root.children].filter(Boolean)))observer.observe(node);
    }
    viewport?.addEventListener('scroll',schedule);win.addEventListener('resize',schedule);root.addEventListener('toggle',schedule,true);update();schedule();
    return ()=>{
      disposed=true;observer?.disconnect();viewport?.removeEventListener('scroll',schedule);win.removeEventListener('resize',schedule);root.removeEventListener('toggle',schedule,true);
      if(frame!=null)win.clearTimeout(frame);
      root.style.removeProperty('--pc-pane-height');body.classList.remove('pc-pane-body');host?.classList.remove('pc-pane-section');
    };
  }
  g.PaperLayout={paneHeight,attach};if(typeof module!=='undefined')module.exports=g.PaperLayout;
})(globalThis);
