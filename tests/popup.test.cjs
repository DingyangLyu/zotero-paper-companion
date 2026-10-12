const {test} = require('node:test');
const assert = require('node:assert/strict');
global.PCCore = require('../plugin/content/core.js');
const {Translator} = require('../plugin/content/popup.js');

const quote = {itemID: 1, pageIndex: 2, text: 'samples'};
const tick = () => new Promise(r => setImmediate(r));

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return {promise, resolve, reject};
}

test('a re-rendered popup re-attaches to the running job instead of restarting it', async () => {
  let calls = 0;
  const d = deferred();
  const t = new Translator({run: async (job, update) => { calls++; update({text: '样'}); return d.promise; }});
  const opts = {ref: 'api::k3', language: 'zh', label: 'K3'};
  const first = [];
  const view1 = job => first.push(job.status + ':' + job.text);
  const job = t.acquire(quote, opts);
  t.attach(job, view1);
  await tick();
  t.detach(job, view1);
  const again = t.acquire(quote, opts);
  assert.equal(again, job);
  const second = [];
  t.attach(again, job2 => second.push(job2.status + ':' + job2.text));
  d.resolve('样本');
  await tick();
  assert.equal(calls, 1);
  assert.equal(second.at(-1), 'done:样本');
});

test('finished translations are served from cache; force re-runs', async () => {
  let calls = 0;
  const t = new Translator({run: async () => `译文${++calls}`});
  const opts = {ref: 'r', language: 'zh'};
  t.acquire(quote, opts);
  await tick();
  assert.equal(t.acquire(quote, opts).text, '译文1');
  assert.equal(calls, 1);
  t.acquire(quote, {...opts, force: true});
  await tick();
  assert.equal(calls, 2);
  t.acquire(quote, {...opts, ref: 'other'});
  await tick();
  assert.equal(calls, 3);
});

test('a job with no views is cancelled after the grace period', async () => {
  let signal;
  const t = new Translator({run: (job) => { signal = job.controller.signal; return new Promise(() => {}); }});
  const view = () => {};
  const job = t.acquire(quote, {ref: 'r', language: 'zh'});
  t.attach(job, view);
  await tick();
  t.detach(job, view);
  assert.equal(signal.aborted, false);
  await new Promise(r => setTimeout(r, 1700));
  assert.equal(signal.aborted, true);
  assert.equal(job.status, 'stopped');
  assert.equal(t.jobs.has(job.key), false);
});

test('errors are reported to the view and retried on the next acquire', async () => {
  let calls = 0;
  const t = new Translator({run: async () => { if (++calls === 1) throw new Error('HTTP 401 sk-abcdefghijklmn'); return 'ok'; }});
  const seen = [];
  const job = t.acquire(quote, {ref: 'r', language: 'zh'});
  t.attach(job, j => seen.push(j.status));
  await tick();
  assert.equal(job.status, 'error');
  assert(!job.error.includes('sk-abcdefghijklmn'));
  const retry = t.acquire(quote, {ref: 'r', language: 'zh'});
  assert.notEqual(retry, job);
  await tick();
  assert.equal(retry.text, 'ok');
});
