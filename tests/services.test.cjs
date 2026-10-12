const {test} = require('node:test');
const assert = require('node:assert/strict');
global.PCCore = require('../plugin/content/core.js');
global.PCProviders = require('../plugin/content/providers.js');

const prefs = new Map();
global.Zotero = {Prefs: {get: k => prefs.get(k), set: (k, v) => prefs.set(k, v)}};
const S = require('../plugin/content/services.js');
const K = 'extensions.paper-companion.';

// The 0.1.7 settings found on this machine (paths shortened).
const OLD = [
  {id: 'codex', name: 'Codex', type: 'cli', path: '/n/bin/codex', model: 'gpt-6-astra', modelEffort: 'medium',
    models: [{id: 'gpt-6-astra', name: 'GPT-6-Astra', isDefault: true}, {id: 'gpt-5.5', name: 'GPT-5.5'}]},
  {id: 'claude', name: 'Claude Code', type: 'cli', path: '/l/bin/claude', model: '', models: []},
  {id: 'opencode', name: 'OpenCode', type: 'cli', path: '/n/bin/opencode', model: '', models: []},
  {id: 'api-abc', name: 'My API', type: 'api', protocol: 'anthropic', baseURL: 'https://x.org/v1', model: 'm1'},
  {id: 'evil', name: 'x', type: 'api', baseURL: 'https://y.org'},
];

test('0.1.x engines migrate to providers and keep the default engine', () => {
  prefs.clear();
  prefs.set(K + 'engines', JSON.stringify(OLD));
  prefs.set(K + 'defaultEngine', 'opencode');
  const list = S.providers();
  assert.deepEqual(list.map(p => [p.id, p.kind]), [['codex', 'codex'], ['claude', 'claude'], ['opencode', 'opencode'], ['api-abc', 'anthropic']]);
  assert.deepEqual(list[0].models, ['gpt-6-astra', 'gpt-5.5']);
  assert.equal(list[0].modelNames['gpt-6-astra'], 'GPT-6-Astra');
  assert.equal(list[0].effort, 'medium');
  assert.deepEqual(list[3].models, ['m1']);
  assert.equal(prefs.get(K + 'chatModel'), 'opencode::');
  // Migration runs once; the saved providers are used afterwards.
  prefs.set(K + 'engines', '[]');
  assert.equal(S.providers().length, 4);
});

test('model choices list API models first and resolve saved picks', () => {
  const choices = S.modelChoices();
  assert.equal(choices[0].ref, 'api-abc::m1');
  assert(choices.some(c => c.ref === 'codex::gpt-5.5' && c.label === 'Codex · GPT-5.5'));
  assert(choices.some(c => c.ref === 'claude::' && c.label === 'Claude Code · 默认模型'));
  assert.equal(S.resolveModel('chat').ref, 'opencode::');
  assert.equal(S.resolveModel('translate').ref, 'api-abc::m1');
  S.chooseModel('translate', 'codex::gpt-6-astra');
  assert.equal(S.resolveModel('translate').model, 'gpt-6-astra');
  S.chooseModel('translate', 'gone::x');
  assert.equal(S.resolveModel('translate').ref, 'api-abc::m1');
});

test('API providers without models or URL are not offered', () => {
  S.upsertProvider({id: 'api-empty', name: 'Empty', kind: 'openai', baseURL: 'https://z.org/v1', models: []});
  S.upsertProvider({id: 'api-nourl', name: 'NoURL', kind: 'openai', baseURL: '', models: ['m']});
  assert(!S.modelChoices().some(c => ['api-empty', 'api-nourl'].includes(c.provider.id)));
});
