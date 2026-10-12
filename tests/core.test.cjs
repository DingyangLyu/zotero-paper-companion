const {test} = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../plugin/content/core.js');

const block = (text, pageIndex, rect) => ({text, pageIndex, rect});

test('selection normalises text and rejects unusable annotations', () => {
  const q = Core.selection({text: 'multi-\nchannel   images', position: {pageIndex: 3, rects: [[1, 2, 3, 4], ['x']]}, pageLabel: '12'}, 9);
  assert.deepEqual(q, {text: 'multichannel images', itemID: 9, pageIndex: 3, pageLabel: '12', rects: [[1, 2, 3, 4]]});
  assert.equal(Core.selection({text: ' ', position: {pageIndex: 0}}, 1), null);
  assert.equal(Core.selection({text: 'x', position: {pageIndex: -1}}, 1).pageIndex, null);
  assert.equal(Core.userContent('q', {text: 'epub text', pageIndex: null}), '<selection>\nepub text\n</selection>\n\nq');
});

test('isTerm separates words and short phrases from sentences', () => {
  assert.equal(Core.isTerm('abductive'), true);
  assert.equal(Core.isTerm('signal-to-noise ratio'), true);
  assert.equal(Core.isTerm('多通道荧光'), true);
  assert.equal(Core.isTerm('We propose a new benchmark. It covers three tasks.'), false);
  assert.equal(Core.isTerm('this is a much longer phrase with words'), false);
});

test('contextFor picks the paragraph nearest to the selection on its page', () => {
  const blocks = [
    block('Intro mentions samples once.', 0, [0, 0, 10, 10]),
    block('Earlier paragraph about samples.', 3, [0, 0, 100, 50]),
    block('Middle paragraph.', 3, [0, 60, 100, 110]),
    block('Later paragraph also about samples.', 3, [0, 500, 100, 550]),
    block('Next page.', 4, [0, 0, 1, 1]),
  ];
  const r = Core.contextFor(blocks, {text: 'samples', pageIndex: 3, rects: [[10, 510, 20, 520]]}, 1);
  assert.equal(r.found, true);
  assert.deepEqual(r.blocks.map(b => b.text), ['Middle paragraph.', 'Later paragraph also about samples.', 'Next page.']);
  assert.equal(Core.contextFor(blocks, {text: 'absent', pageIndex: 3}).found, false);
});

test('contextFor matches selections that cross a paragraph boundary', () => {
  const blocks = [block('ends with the first', 0), block('half of a sentence.', 0)];
  const r = Core.contextFor(blocks, {text: 'the first half', pageIndex: 0});
  assert.equal(r.found, true);
});

test('paperContext sends short papers whole with page markers', () => {
  const blocks = [block('Abstract text.', 0), block('Method.', 1), block('Results.', 1)];
  const c = Core.paperContext(blocks, {budget: 1000});
  assert.equal(c.complete, true);
  assert.deepEqual(c.pages, [1, 2]);
  assert.match(c.text, /^\[p\.1\]\nAbstract text\.\n\n\[p\.2\]\nMethod\.\nResults\.$/);
});

test('paperContext keeps opening pages, focus page and relevant paragraphs within budget', () => {
  const blocks = [];
  for (let p = 0; p < 30; p++) blocks.push(block(`Page ${p} filler `.repeat(40), p));
  blocks.push(block('The transformer uses attention heads.', 20));
  const c = Core.paperContext(blocks, {budget: 3000, query: 'how many attention heads', focusPage: 10});
  assert.equal(c.complete, false);
  assert(c.chars <= 3000 + 100);
  assert(c.pages.includes(1));
  assert(c.pages.includes(11));
  assert(c.text.includes('attention heads'));
});

test('translation prompt: terms get a dictionary answer, passages a bare translation', () => {
  const term = Core.translation({quote: {text: 'abductive', pageIndex: 3}, blocks: [block('We use abductive reasoning.', 3)], language: '简体中文'});
  assert.equal(term.term, true);
  assert.match(term.system, /两行/);
  assert.match(term.messages[0].content, /<context>\n\[p\.4\] We use abductive reasoning\.\n<\/context>/);
  assert.match(term.messages[0].content, /<selection>\nabductive\n<\/selection>/);
  const passage = Core.translation({quote: {text: 'We propose X. It works well on Y.', pageIndex: 0}});
  assert.equal(passage.term, false);
  assert.match(passage.system, /只输出译文/);
  assert(!passage.messages[0].content.includes('<context>'));
});

test('chat prompt puts the paper in the system prompt and keeps roles alternating', () => {
  const history = [
    {role: 'user', text: '> q\n\nold', question: 'old', quote: {text: 'q', pageIndex: 1}, status: 'complete'},
    {role: 'assistant', text: 'answer', status: 'complete'},
    {role: 'user', text: 'failed', question: 'failed', status: 'complete'},
    {role: 'assistant', text: '', status: 'error'},
  ];
  const r = Core.chat({paper: {text: '[p.1]\nBody', complete: true}, title: 'T"x', history, question: 'new', quote: null});
  assert.match(r.system, /<paper title="T'x">\n\[p\.1\]\nBody\n<\/paper>/);
  assert.deepEqual(r.messages.map(m => m.role), ['user', 'assistant', 'user']);
  assert.match(r.messages[0].content, /<selection page="2">\nq\n<\/selection>\n\nold/);
  assert.equal(r.messages[2].content, 'new');
  assert.match(Core.chat({paper: {text: 'x', complete: false}, question: 'y'}).system, /只节选/);
});

test('flatten serialises prompts for CLI engines', () => {
  assert.equal(Core.flatten({system: 'S', messages: [{role: 'user', content: 'U'}]}), 'SYSTEM:\nS\n\nUSER:\nU\n');
});

test('model refs round-trip, including empty and slashed model names', () => {
  assert.equal(Core.modelRef('api-1', 'k3'), 'api-1::k3');
  assert.deepEqual(Core.parseModelRef('opencode::anthropic/k3'), {providerID: 'opencode', model: 'anthropic/k3'});
  assert.deepEqual(Core.parseModelRef('codex::'), {providerID: 'codex', model: ''});
});

test('links: only supplied pages jump; web links stay http(s)', () => {
  assert.deepEqual(Core.parseLink('paper://page/2', 5, [2]), {kind: 'page', pageIndex: 1});
  assert.deepEqual(Core.parseLink('#page=3', 5, [2]), {kind: 'blocked'});
  assert.deepEqual(Core.parseLink('javascript:alert(1)', 5, []), {kind: 'blocked'});
  assert.equal(Core.parseLink('https://example.org/a', 5, []).kind, 'external');
});

test('redact hides keys and bearer tokens', () => {
  assert.equal(Core.redact('bad key sk-ant-abcdefghijkl and Bearer xyz'), 'bad key [已隐藏密钥] and Bearer [已隐藏]');
});
