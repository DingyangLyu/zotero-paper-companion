const {test}=require('node:test');const assert=require('node:assert/strict');
const Core=require('../plugin/content/core.js');
test('selection identity, finite PDF coordinates and length bounds',()=>{
 assert.equal(Core.selection({text:'x',position:{pageIndex:-1}},2),null);
 const q=Core.selection({text:' inter-\natomic ',pageLabel:'S2',position:{pageIndex:2,rects:[[1,2,3,4],[1,NaN,2,3]]}},7);
 assert.deepEqual(q,{text:'interatomic',pageLabel:'S2',pageIndex:2,itemID:7,rects:[[1,2,3,4]]});
});
test('context uses selected page and geometry rather than first document occurrence',()=>{
 const blocks=[{text:'term unrelated',pageIndex:0,rect:[0,0,20,20]},{text:'first term',pageIndex:1,rect:[0,100,20,120]},{text:'middle paragraph',pageIndex:1},{text:'second term in physics',pageIndex:1,rect:[0,0,20,20]},{text:'following explanation',pageIndex:1}];
 const context=Core.contextFor(blocks,{text:'term',pageIndex:1,rects:[[0,1,10,10]]},1);
 assert.equal(context.blocks[1].text,'second term in physics');assert.equal(context.blocks.length,3);
});
test('context at page boundary includes adjacent paragraph; missing phrase is explicit',()=>{
 const b=[{text:'before',pageIndex:0},{text:'chosen passage',pageIndex:1},{text:'after',pageIndex:1}];
 assert.equal(Core.contextFor(b,{text:'chosen',pageIndex:1},1).blocks[0].pageIndex,0);
 assert.equal(Core.contextFor(b,{text:'missing',pageIndex:1},1).found,false);
});
test('large paragraphs retain selection and obey total context limit',()=>{
 const b=[{text:'a'.repeat(9000),pageIndex:0},{text:'b'.repeat(10000)+' TARGET '+'c'.repeat(9000),pageIndex:0},{text:'d'.repeat(9000),pageIndex:0}];
 const c=Core.contextFor(b,{text:'TARGET',pageIndex:0},2);
 assert(c.blocks[1].text.includes('TARGET'));assert(c.blocks.reduce((s,b)=>s+b.text.length,0)<=16000);
});
test('translation prompt separates target from contextual paragraphs and excludes failed history',()=>{
 const m=Core.messages({kind:'translate',quote:{text:'charge'},blocks:[{text:'electronic charge density',pageIndex:3}],history:[{role:'assistant',text:'BAD',status:'error'}]});
 assert.equal(m.length,2);const data=JSON.parse(m[1].content.slice(m[1].content.indexOf('{')));
 assert.equal(data.selected_text,'charge');assert.equal(data.context[0].source,'[p.4]');assert(m[1].content.includes('只翻译 selected_text'));
});
test('citations require provided pages; executable/local-file links are blocked',()=>{
 assert.deepEqual(Core.parseLink('paper://page/4',10,[4]),{kind:'page',pageIndex:3});
 for(const link of ['paper://page/3','#page=99','javascript:alert(1)','file:///etc/passwd','data:text/html,test'])assert.equal(Core.parseLink(link,10,[4]).kind,'blocked');
 assert.equal(Core.parseLink('https://example.org',10).kind,'external');
});
test('selection can span two contiguous paragraphs',()=>{
 const c=Core.contextFor([{text:'First half of',pageIndex:0},{text:'the selection is here.',pageIndex:0}],{text:'half of the selection',pageIndex:0},1);
 assert(c.found);assert.equal(c.blocks.length,2);
});
test('Chinese QA gets late sections of short English papers',()=>{
 const blocks=[{text:'Abstract introduction',pageIndex:0},{text:'Conclusion and limitations',pageIndex:8}];
 assert.deepEqual(Core.retrieve(blocks,'有哪些限制'),blocks);
});
