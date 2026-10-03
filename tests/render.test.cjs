const {test}=require('node:test');const assert=require('node:assert/strict');const {JSDOM}=require('jsdom');
global.PaperCore=require('../plugin/content/core.js');global.marked=require('marked').marked;global.katex=require('../plugin/content/vendor/katex/katex.min.js');const Render=require('../plugin/content/render.js');
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
