const {test} = require('node:test');
const assert = require('node:assert/strict');
global.PCCore = require('../plugin/content/core.js');
const P = require('../plugin/content/providers.js');

const prompt = {system: 'SYS', messages: [{role: 'user', content: 'hi'}]};
const kimi = {id: 'api-1', name: 'Kimi', kind: 'anthropic', baseURL: 'https://api.kimi.com/coding/v1/'};

test('endpoint appends the protocol path once and enforces HTTPS', () => {
  assert.equal(P.endpoint(kimi), 'https://api.kimi.com/coding/v1/messages');
  assert.equal(P.endpoint({kind: 'openai', baseURL: 'https://x.org/v1/chat/completions'}), 'https://x.org/v1/chat/completions');
  assert.equal(P.endpoint({kind: 'responses', baseURL: 'http://127.0.0.1:8080/v1'}), 'http://127.0.0.1:8080/v1/responses');
  assert.throws(() => P.endpoint({kind: 'openai', baseURL: 'http://example.org/v1'}), /HTTPS/);
  assert.throws(() => P.endpoint({kind: 'openai', baseURL: 'https://u:p@x.org/v1'}), /账号/);
  assert.throws(() => P.endpoint({kind: 'openai', baseURL: 'nonsense'}), /无效/);
});

test('anthropic translation requests disable thinking; chat leaves it to the provider', () => {
  const t = P.buildRequest(kimi, 'k3', prompt, {key: 'secret', task: 'translate'});
  assert.equal(t.headers['x-api-key'], 'secret');
  assert.deepEqual(t.body.thinking, {type: 'disabled'});
  assert.equal(t.body.system, 'SYS');
  assert.equal(t.body.max_tokens, 2048);
  const c = P.buildRequest(kimi, 'k3', prompt, {task: 'chat', thinking: true});
  assert.equal(c.body.thinking, undefined);
  assert.equal(c.body.max_tokens, 8192);
  assert.deepEqual(P.buildRequest(kimi, 'k3', prompt, {task: 'chat', thinking: false}).body.thinking, {type: 'disabled'});
  assert.throws(() => P.buildRequest(kimi, '', prompt), /模型名称/);
});

test('openai-style requests put the system prompt first', () => {
  const r = P.buildRequest({kind: 'openai', baseURL: 'https://x.org/v1'}, 'm', prompt, {key: 'k'});
  assert.equal(r.headers.Authorization, 'Bearer k');
  assert.deepEqual(r.body.messages, [{role: 'system', content: 'SYS'}, {role: 'user', content: 'hi'}]);
  const resp = P.buildRequest({kind: 'responses', baseURL: 'https://x.org/v1'}, 'm', prompt);
  assert.equal(resp.body.instructions, 'SYS');
  assert.equal(resp.body.store, false);
});

test('parseEvent extracts text and thinking markers for each protocol', () => {
  assert.deepEqual(P.parseEvent('anthropic', {type: 'content_block_delta', delta: {type: 'text_delta', text: '溯'}}), {text: '溯'});
  assert.deepEqual(P.parseEvent('anthropic', {type: 'content_block_delta', delta: {type: 'thinking_delta', thinking: 'x'}}), {thinking: true});
  assert.deepEqual(P.parseEvent('openai', {choices: [{delta: {content: 'a'}}]}), {text: 'a'});
  assert.deepEqual(P.parseEvent('openai', {choices: [{delta: {reasoning_content: 'a'}}]}), {thinking: true});
  assert.deepEqual(P.parseEvent('responses', {type: 'response.output_text.delta', delta: 'b'}), {text: 'b'});
  assert.throws(() => P.parseEvent('anthropic', {type: 'error', error: {message: 'overloaded'}}), /overloaded/);
});

test('sseParser handles split chunks, CRLF and multi-line data', () => {
  const out = [];
  const s = P.sseParser(d => out.push(d));
  s.push('event: x\r\ndata: {"a":');
  s.push('1}\r\n\r\ndata: line1\ndata: line2\n\ndata: [DONE]');
  s.end();
  assert.deepEqual(out, ['{"a":1}', 'line1\nline2', '[DONE]']);
});

function streamResponse(chunks, {status = 200, type = 'text/event-stream'} = {}) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    ok: status >= 200 && status < 300, status,
    headers: {get: () => type},
    body: {getReader: () => ({read: async () => (i < chunks.length ? {done: false, value: enc.encode(chunks[i++])} : {done: true}), cancel: async () => {}})},
    text: async () => chunks.join(''),
    json: async () => JSON.parse(chunks.join('')),
  };
}

test('runAPI streams anthropic text and reports thinking before text', async () => {
  const seen = [];
  let thinking = 0;
  const events = [
    {type: 'content_block_start', content_block: {type: 'thinking'}},
    {type: 'content_block_delta', delta: {type: 'text_delta', text: '溯因'}},
    {type: 'content_block_delta', delta: {type: 'text_delta', text: '推理'}},
  ].map(e => `data: ${JSON.stringify(e)}\n\n`);
  const text = await P.runAPI(kimi, 'k3', prompt, {
    fetch: async () => streamResponse(events), TextDecoder, signal: new AbortController().signal,
    onText: t => seen.push(t), onThinking: () => thinking++,
  });
  assert.equal(text, '溯因推理');
  assert.deepEqual(seen, ['溯因', '溯因推理']);
  assert.equal(thinking, 1);
});

test('runAPI retries once without the thinking switch when the server rejects it', async () => {
  const bodies = [];
  const fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return bodies.length === 1 ? streamResponse(['{"error":{"message":"unknown field thinking"}}'], {status: 400, type: 'application/json'})
      : streamResponse(['{"content":[{"type":"text","text":"ok"}]}'], {type: 'application/json'});
  };
  const text = await P.runAPI(kimi, 'k3', prompt, {fetch, TextDecoder, task: 'translate', onText: () => {}});
  assert.equal(text, 'ok');
  assert.deepEqual(bodies[0].thinking, {type: 'disabled'});
  assert.equal(bodies[1].thinking, undefined);
});

test('runAPI turns HTTP failures into actionable messages without leaking keys', async () => {
  const fetch = async () => streamResponse(['{"error":{"message":"invalid key sk-abcdefghijklmnop"}}'], {status: 401, type: 'application/json'});
  await assert.rejects(P.runAPI(kimi, 'k3', prompt, {fetch, TextDecoder, onText: () => {}}), e => {
    assert.match(e.message, /API Key 无效或已过期（HTTP 401）/);
    assert(!e.message.includes('sk-abcdefghijklmnop'));
    return true;
  });
  const offline = async () => { throw new TypeError('NetworkError'); };
  await assert.rejects(P.runAPI(kimi, 'k3', prompt, {fetch: offline, TextDecoder, onText: () => {}}), /无法连接到 api\.kimi\.com/);
});

test('CLI plans keep agents read-only and speed up codex translations', () => {
  const codex = P.cliPlan('codex', 'gpt-x', {effort: 'high', task: 'translate'});
  assert(codex.args.includes('read-only'));
  assert(codex.args.includes('model_reasoning_effort="low"'));
  assert(P.cliPlan('codex', '', {effort: 'high', task: 'chat'}).args.includes('model_reasoning_effort="high"'));
  const claude = P.cliPlan('claude', 'sonnet');
  assert.deepEqual(claude.args.slice(claude.args.indexOf('--tools'), claude.args.indexOf('--tools') + 2), ['--tools', '']);
  const oc = P.cliPlan('opencode', '');
  assert.equal(JSON.parse(oc.environment.OPENCODE_CONFIG_CONTENT).permission['*'], 'deny');
  assert.throws(() => P.cliPlan('bash', ''), /未知/);
});

test('cliEvent understands each CLI stream', () => {
  assert.deepEqual(P.cliEvent('codex', {type: 'item.completed', item: {type: 'agent_message', text: 'A'}}), {text: 'A'});
  assert.deepEqual(P.cliEvent('claude', {type: 'result', result: 'B'}), {text: 'B', replace: true});
  assert.deepEqual(P.cliEvent('opencode', {type: 'text', part: {text: 'C'}}), {text: 'C'});
  assert.throws(() => P.cliEvent('claude', {type: 'result', is_error: true, result: 'quota'}), /quota/);
});

test('OpenCode import finds providers with literal keys and honours whitelists', () => {
  const raw = `{
    // comment with "quotes"
    "provider": {
      "anthropic": {"name": "Kimi", "options": {"baseURL": "https://api.kimi.com/coding/v1", "apiKey": "sk-kimi-x//y"},
        "models": {"k3": {}, "k3-256k": {}, "other": {}}, "whitelist": ["k3", "k3-256k"]},
      "env": {"options": {"baseURL": "https://e.org/v1", "apiKey": "{env:KEY}"}},
      "openai": {"options": {"reasoningEffort": "medium"}},
      "ds": {"npm": "@ai-sdk/openai-compatible", "options": {"baseURL": "https://api.deepseek.com/v1", "apiKey": "k"}, "models": {"deepseek-chat": {}},},
    },
  }`;
  const found = P.opencodeCandidates(JSON.parse(P.stripJSONComments(raw)));
  assert.deepEqual(found.map(f => [f.source, f.kind, f.models.join(',')]), [['anthropic', 'anthropic', 'k3,k3-256k'], ['ds', 'openai', 'deepseek-chat']]);
  assert.equal(found[0].key, 'sk-kimi-x//y');
});

test('codex model list filters hidden and malformed entries', () => {
  const list = P.codexModelList({data: [{model: 'a', displayName: 'A', isDefault: true, defaultReasoningEffort: 'medium'}, {model: 'b c'}, {model: 'h', hidden: true}]});
  assert.deepEqual(list, [{id: 'a', name: 'A', isDefault: true, effort: 'medium'}]);
});
