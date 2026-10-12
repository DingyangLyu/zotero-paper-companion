const {test} = require('node:test');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
global.PCCore = require('../plugin/content/core.js');
global.marked = require('marked').marked;
global.katex = require('../plugin/content/vendor/katex/katex.min.js');
require('../plugin/content/render.js');
const ChatPane = require('../plugin/content/sidebar.js');

const tick = (n = 5) => new Promise(async r => { for (let i = 0; i < n; i++) await new Promise(x => setImmediate(x)); r(); });
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return {promise, resolve, reject};
}

// A fake Zotero with one reader tab, a fake disk and a controllable model.
function setup({disk = new Map()} = {}) {
  const dom = new JSDOM('<div id="pane"></div>');
  const win = dom.window;
  win.ResizeObserver = class { observe() {} disconnect() {} };
  const reader = {itemID: 7, tabID: 'tab-1', navigate() {}};
  const calls = [];
  const logs = [];
  global.Zotero = {
    getMainWindow: () => win,
    Reader: {getByTabID: id => (id === 'tab-1' ? reader : null)},
    Items: {get: () => ({isPDFAttachment: () => true})},
    launchURL() {},
  };
  const choice = {ref: 'api::m', label: 'Model', group: 'API', provider: {kind: 'anthropic'}, model: 'm'};
  global.PCServices = {
    getReader: () => reader,
    paperIdentity: async () => ({key: '1_ABC', title: 'Paper', item: {}}),
    loadChat: async key => JSON.parse(JSON.stringify(disk.get(key) || [])),
    saveChat: async (key, messages) => { disk.set(key, JSON.parse(JSON.stringify(messages))); },
    archiveChat: async key => { disk.delete(key); },
    readPaper: async () => ({blocks: [{text: 'Body text.', pageIndex: 0, index: 0}], pageCount: 1}),
    resolveModel: () => choice,
    modelChoices: () => [choice],
    chooseModel() {},
    pref: (name, fallback) => fallback,
    setPref() {},
    runOptions: async (c, opts) => opts,
    log: (event, data) => logs.push({event, ...data}),
  };
  global.PCProviders = {
    isAPI: () => true,
    run: (provider, model, prompt, opts) => {
      const call = {prompt, opts, ...deferred()};
      opts.signal.addEventListener('abort', () => call.reject(new Error('aborted')));
      calls.push(call);
      return call.promise;
    },
  };
  const doc = win.document;
  const plugin = {
    element(d, tag, cls, text) {
      const e = d.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    },
    button(d, text, action, cls) {
      const b = this.element(d, 'button', cls, text);
      b.addEventListener('click', action);
      return b;
    },
    copyText() {},
    openSettings() {},
  };
  const chat = new ChatPane(plugin);
  const newBody = () => {
    const body = doc.createElement('div');
    doc.querySelector('#pane').replaceChildren(body);
    return body;
  };
  const open = async () => {
    const body = newBody();
    chat.render({doc, body});
    await tick();
    return chat.views.get(body);
  };
  const enter = v => v.input.dispatchEvent(new win.KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
  const texts = v => [...v.list.querySelectorAll('.pc-msg')].map(n => n.dataset.role + ':' + n.textContent.trim().slice(0, 40));
  // Abort whatever is still running so the watchdog timers stop.
  const done = async () => { chat.shutdown(); await tick(); win.close(); };
  return {win, doc, chat, disk, calls, logs, open, enter, texts, done};
}

test('a question is written to disk the moment it is asked', async () => {
  const t = setup();
  const v = await t.open();
  v.input.value = '这篇论文做了什么？';
  t.enter(v);
  await tick();
  const saved = t.disk.get('1_ABC');
  assert.equal(saved.length, 2);
  assert.equal(saved[0].question, '这篇论文做了什么？');
  assert.equal(saved[1].status, 'pending');
  assert.equal(v.input.value, '');
  t.calls[0].resolve('它提出了 X。');
  await tick();
  assert.equal(t.disk.get('1_ABC')[1].status, 'complete');
  assert.equal(t.disk.get('1_ABC')[1].text, '它提出了 X。');
  await t.done();
});

test('rebuilding the pane mid-answer keeps the question and the streaming answer', async () => {
  const t = setup({disk: new Map([['1_ABC', [
    {role: 'user', text: '上一问', question: '上一问', status: 'complete'},
    {role: 'assistant', text: '上一答', status: 'complete'},
  ]]])});
  const v1 = await t.open();
  v1.input.value = '新问题';
  t.enter(v1);
  await tick();
  t.calls[0].opts.onText('部分回答');
  // Zotero replaces the section body (tab reload, pane re-creation, ...).
  t.chat.destroy(v1.body);
  const v2 = await t.open();
  assert.notEqual(v1, v2);
  assert.deepEqual(t.texts(v2).map(x => x.split(':')[0]), ['user', 'assistant', 'user', 'assistant']);
  assert.match(t.texts(v2)[2], /新问题/);
  assert.equal(v2.sendButton.textContent, '停止');
  t.calls[0].opts.onText('部分回答，完整');
  t.calls[0].resolve('部分回答，完整');
  await tick();
  assert.match(t.texts(v2)[3], /部分回答，完整/);
  assert.equal(v2.sendButton.textContent, '发送');
  const saved = t.disk.get('1_ABC');
  assert.equal(saved.length, 4);
  assert.equal(saved[3].status, 'complete');
  assert.equal(t.calls.length, 1, 'the request was not restarted');
  await t.done();
});

test('a message that fails to render does not wipe the conversation', async () => {
  const t = setup({disk: new Map([['1_ABC', [
    {role: 'user', text: 'q1', question: 'q1', status: 'complete'},
    {role: 'assistant', text: 'BAD', status: 'complete'},
  ]]])});
  const render = PCRender.render;
  PCRender.render = (doc, node, text, opts) => {
    if (text === 'BAD') throw new Error('boom');
    return render(doc, node, text, opts);
  };
  try {
    const v = await t.open();
    assert.equal(t.texts(v).length, 2);
    v.input.value = 'q2';
    t.enter(v);
    await tick();
    assert.equal(t.texts(v).length, 4);
    assert.match(t.texts(v)[1], /BAD/);
    assert.match(t.texts(v)[2], /q2/);
    assert.equal(t.calls.length, 1);
    assert.ok(t.logs.some(l => l.event === 'render-failed'));
  } finally {
    PCRender.render = render;
    await t.done();
  }
});

test('Enter while an answer is generating keeps the typed text and says why', async () => {
  const t = setup();
  const v = await t.open();
  v.input.value = '第一问';
  t.enter(v);
  await tick();
  v.input.value = '第二问';
  t.enter(v);
  await tick();
  assert.equal(v.input.value, '第二问');
  assert.equal(v.status.hidden, false);
  assert.match(v.status.textContent, /还在生成/);
  assert.equal(t.calls.length, 1);
  await t.done();
});

test('Enter that confirms an input-method candidate does not send', async () => {
  const t = setup();
  const v = await t.open();
  v.input.value = '中文';
  v.input.dispatchEvent(new t.win.KeyboardEvent('keydown', {key: 'Enter', isComposing: true, bubbles: true, cancelable: true}));
  v.input.dispatchEvent(new t.win.Event('compositionend'));
  t.enter(v);
  await tick();
  assert.equal(t.calls.length, 0);
  assert.equal(v.input.value, '中文');
  await t.done();
});

test('a pending answer left on disk becomes a retryable error', async () => {
  const t = setup({disk: new Map([['1_ABC', [
    {role: 'user', text: 'q', question: 'q', status: 'complete'},
    {role: 'assistant', text: '', status: 'pending'},
  ]]])});
  const v = await t.open();
  assert.match(v.list.textContent, /上次回答未完成/);
  const retry = [...v.list.querySelectorAll('button')].find(b => b.textContent === '重试');
  retry.click();
  await tick();
  assert.equal(t.calls.length, 1);
  assert.equal(t.chat.sessions.get('1_ABC').history.length, 2);
  await t.done();
});

test('stop keeps the partial answer and saves it as stopped', async () => {
  const t = setup();
  const v = await t.open();
  v.input.value = 'q';
  t.enter(v);
  await tick();
  t.calls[0].opts.onText('半句');
  v.sendButton.click();
  await tick();
  const saved = t.disk.get('1_ABC');
  assert.equal(saved[1].status, 'partial');
  assert.equal(saved[1].text, '半句');
  assert.match(t.texts(v)[1], /已停止/);
  assert.equal(v.sendButton.textContent, '发送');
  await t.done();
});
