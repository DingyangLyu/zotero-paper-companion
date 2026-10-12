const {test}=require('node:test');const assert=require('node:assert/strict');const {JSDOM}=require('jsdom');
global.PCCore=require('../plugin/content/core.js');global.marked=require('marked').marked;global.katex=require('../plugin/content/vendor/katex/katex.min.js');const Render=require('../plugin/content/render.js');
function draw(text,options={}){const dom=new JSDOM('<div id="chat"></div>');const p=dom.window.document.querySelector('#chat');Render.render(dom.window.document,p,text,options);return p;}
test('Markdown and all common LaTeX delimiters render native MathML',()=>{
 const p=draw('**结论**：$E=mc^2$\n\n$$\\frac{a}{b}$$\n\n\\(x_i\\) 与 \\[\\sum_{i=1}^n i\\]\n\n\\begin{equation}y=x^2\\end{equation}');
 assert(p.querySelector('strong'));assert.equal(p.querySelectorAll('math').length,5);assert.equal(p.querySelectorAll('mfrac').length,1);
});
test('code dollars remain literal and bad math retains original TeX',()=>{
 const p=draw('`$NOT_MATH$`\n\n```latex\n$NO$\n```\n\n$\\unknownmacro{x}$');
 assert.equal(p.querySelectorAll('math').length,0);assert(p.textContent.includes('unknownmacro'));assert(p.textContent.includes('$NOT_MATH$'));
});
test('model HTML cannot introduce scripts, handlers, images or executable links',()=>{
 const p=draw('<script>window.pwned=1</script>\n\n<img src="https://example.org/track" onerror="alert(1)">\n\n[bad](javascript:alert%281%29)\n\n$\\href{javascript:alert(1)}{X}$');
 assert.equal(p.querySelectorAll('script,img,iframe,svg').length,0);assert.equal(p.querySelectorAll('[onclick],[onerror]').length,0);assert(!p.querySelector('a[href^="javascript"]'));
});
test('only supplied page citations jump and web links use explicit callback',()=>{
 let page=null,url=null;const p=draw('见 [p.2] 与 [p.99]。[论文](https://example.org/paper)',{pageCount:10,sources:[2],onPage:x=>page=x,onExternal:x=>url=x});
 assert.equal(p.querySelectorAll('button').length,1);p.querySelector('button').click();assert.equal(page,1);p.querySelector('a').click();assert.equal(url,'https://example.org/paper');
});
test('tables scroll instead of squeezing columns: short cells stay on one line, long cells keep a readable width',()=>{
 const long='离散原子类型在连续空间扩散，带来额外误差，并且需要很长的训练时间才能收敛到较好的结果';
 const p=draw('| 方法 | 结果 | 局限 |\n|:--|--:|---|\n| EDM | 82.0% | '+long+' |');
 const wrap=p.querySelector('.pc-table');assert(wrap);assert.equal(wrap.firstElementChild.localName,'table');
 const cells=[...p.querySelectorAll('td')];
 assert(cells[0].classList.contains('pc-cell-short'));assert(cells[1].classList.contains('pc-cell-short'));
 assert.equal(cells[1].style.textAlign,'right');
 const inner=cells[2].querySelector('.pc-cell');assert(inner);assert.equal(inner.textContent,long);
 assert.match(inner.style.minWidth,/^(\d+)em$/);assert(parseInt(inner.style.minWidth)>=6 && parseInt(inner.style.minWidth)<=14);
});
test('h5/h6 and sub/sup keep their text',()=>{
 const p=draw('##### 小节\n\nH<sub>2</sub>O 与 x<sup>2</sup>');
 assert.equal(p.querySelector('h5').textContent,'小节');assert.equal(p.querySelector('sub').textContent,'2');assert.equal(p.querySelector('sup').textContent,'2');
});
test('renders inside an XML (XHTML) document like Zotero\'s main window: line breaks, rules and entities',()=>{
 const dom=new JSDOM('<html xmlns="http://www.w3.org/1999/xhtml"><body><div id="c"></div></body></html>',{contentType:'application/xhtml+xml'});
 const doc=dom.window.document;const p=doc.getElementById('c');
 Render.render(doc,p,'第一行\n第二行 $x$\n\n---\n\nA&nbsp;B &copy; <br> 结束\n\n| a | b |\n|---|---|\n| 1<br>2 | 3 |',{});
 assert.equal(p.querySelectorAll('br').length>=2,true);assert(p.querySelector('hr'));assert(p.querySelector('math'));assert(p.querySelector('.pc-table td'));
 assert(p.textContent.includes('第二行'));assert(p.textContent.includes('©'));
});
