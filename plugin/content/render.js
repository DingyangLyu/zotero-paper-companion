(function(g) {
  'use strict';
  const NS='http://www.w3.org/1999/xhtml', MATH='http://www.w3.org/1998/Math/MathML';
  const ALLOWED=new Set('p div span strong em del s code pre blockquote ul ol li h1 h2 h3 h4 hr br table thead tbody tr th td a'.split(' '));
  function protectMath(text) {
    const math=[];
    // Fenced and inline code are matched first so dollars in code stay literal.
    const pattern=/```[^\n]*\n[\s\S]*?(?:```|$)|`[^`\n]*`|\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<!\\)\$([^$\n]+?)(?<!\\)\$|\\begin\{(equation\*?|align\*?|aligned|gather\*?)\}([\s\S]+?)\\end\{\5\}/g;
    const source=String(text).replace(pattern,(all, dollars, bracket, paren, inline, env, body)=>{
      if(all.startsWith('`'))return all;
      let tex=dollars ?? bracket ?? paren ?? inline ?? body;
      if(env && /^(align|gather)/.test(env))tex='\\begin{aligned}'+body+'\\end{aligned}';
      const id=math.push({tex,display:!!(dollars || bracket || env)})-1;
      return '<span data-pc-math="'+id+'"></span>';
    });
    return {source,math};
  }
  function mathNode(doc,entry) {
    if(entry.tex.length>12000)return doc.createTextNode(entry.tex);
    try {
      const markup=g.katex.renderToString(entry.tex,{output:'mathml',displayMode:entry.display,trust:false,throwOnError:true,maxExpand:500,maxSize:15,strict:'ignore',macros:{}});
      const parsed=new doc.defaultView.DOMParser().parseFromString(markup,'application/xml');
      const math=parsed.getElementsByTagNameNS(MATH,'math')[0];
      if(!math || parsed.getElementsByTagName('parsererror').length)throw new Error('公式解析失败');
      for(const el of [math,...math.getElementsByTagName('*')]) {
        if(el.namespaceURI!==MATH || ['annotation-xml','maction'].includes(el.localName))throw new Error('非法公式');
        for(const attr of el.attributes)if(/^on/i.test(attr.name) || ['href','src','style','id','class'].includes(attr.localName))throw new Error('非法公式属性');
      }
      const node=doc.importNode(math,true);node.setAttribute('aria-label',entry.tex);return node;
    } catch(_) {const code=doc.createElementNS(NS,'code');code.textContent=entry.tex;code.title='公式无法解析，保留 LaTeX 原文';return code;}
  }
  function render(doc,parent,text,{pageCount=0,sources=[],onPage=()=>{},onExternal=()=>{}}={}) {
    const {source,math}=protectMath(String(text).slice(0,200000));
    const template=doc.createElementNS(NS,'template');
    template.innerHTML=g.marked.parse(source,{gfm:true,breaks:true});
    const fragment=doc.createDocumentFragment();
    const addText=(target,value,code)=>{
      if(code){target.append(doc.createTextNode(value));return;}
      let offset=0;
      for(const match of value.matchAll(/\[p\.(\d+)\]/gi)) {
        target.append(doc.createTextNode(value.slice(offset,match.index)));
        const page=Number(match[1]);
        if(page<=pageCount && sources.includes(page)) {
          const button=doc.createElementNS(NS,'button');button.type='button';button.className='pc-citation';button.textContent='第 '+page+' 页';button.addEventListener('click',()=>onPage(page-1));target.append(button);
        } else target.append(doc.createTextNode(match[0]));
        offset=match.index+match[0].length;
      }
      target.append(doc.createTextNode(value.slice(offset)));
    };
    const copy=(node,target,inCode=false)=>{
      if(node.nodeType===3){addText(target,node.nodeValue,inCode);return;}
      if(node.nodeType!==1)return;
      const name=node.localName.toLowerCase();
      if(name==='span' && /^\d+$/.test(node.getAttribute('data-pc-math') || '')) {
        const entry=math[Number(node.getAttribute('data-pc-math'))];if(entry)target.append(mathNode(doc,entry));return;
      }
      if(!ALLOWED.has(name)){if(name==='img')target.append(doc.createTextNode(node.getAttribute('alt') || '[图片]'));return;}
      const element=doc.createElementNS(NS,name);target.append(element);
      if(name==='a') {
        const link=g.PaperCore.parseLink(node.getAttribute('href'),pageCount,sources);
        if(link.kind!=='blocked') {
          element.href=link.kind==='external'?link.url:'#';
          element.addEventListener('click',e=>{e.preventDefault();if(link.kind==='page')onPage(link.pageIndex);else onExternal(link.url);});
        }
      }
      for(const child of node.childNodes)copy(child,element,inCode || ['pre','code'].includes(name));
    };
    for(const child of template.content.childNodes)copy(child,fragment);
    parent.replaceChildren(fragment);
  }
  const api={protectMath,mathNode,render};g.PaperRender=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
