/* Paper Companion — Zotero-facing services: settings, secrets, engine
 * discovery, paper text and chat history. */
(function (g) {
  'use strict';
  const PREFIX = 'extensions.paper-companion.';
  const LOGIN_ORIGIN = 'chrome://paper-companion';
  const LOGIN_REALM = 'Paper Companion API';
  const P = () => g.PCProviders;
  const C = () => g.PCCore;

  function pref(name, fallback) {
    const value = g.Zotero.Prefs.get(PREFIX + name, true);
    return value === undefined || value === null || value === '' ? fallback : value;
  }
  function setPref(name, value) {
    g.Zotero.Prefs.set(PREFIX + name, value, true);
  }

  // ---- providers ---------------------------------------------------------

  function cleanProvider(x) {
    const kind = P().KINDS[x.kind] ? x.kind : 'openai';
    return {
      id: String(x.id),
      name: String(x.name || P().KINDS[kind].label).slice(0, 80),
      kind,
      baseURL: P().KINDS[kind].api ? String(x.baseURL || '').trim() : '',
      path: P().KINDS[kind].cli ? String(x.path || '').trim() : '',
      models: [...new Set((Array.isArray(x.models) ? x.models : []).map(m => String(m).trim()).filter(Boolean))].slice(0, 100),
      modelNames: x.modelNames && typeof x.modelNames === 'object' ? x.modelNames : {},
      effort: P().EFFORTS.includes(x.effort) ? x.effort : '',
      enabled: x.enabled !== false,
    };
  }

  // 0.1.x stored {id,name,type:'cli'|'api',path,model,protocol,baseURL,models}.
  function migrateEngines(old) {
    const providers = [];
    for (const e of Array.isArray(old) ? old : []) {
      if (e.type === 'cli' && P().CLI_KINDS.includes(e.id)) {
        const models = (e.models || []).map(m => typeof m === 'string' ? m : m.id).filter(Boolean);
        if (e.model && !models.includes(e.model)) models.unshift(e.model);
        const modelNames = Object.fromEntries((e.models || []).filter(m => m?.id && m.name).map(m => [m.id, m.name]));
        providers.push(cleanProvider({id: e.id, name: e.name, kind: e.id, path: e.path, models, modelNames, effort: e.modelEffort}));
      } else if (e.type === 'api' && /^api-[\w-]+$/.test(e.id)) {
        const kind = {anthropic: 'anthropic', responses: 'responses'}[e.protocol] || 'openai';
        providers.push(cleanProvider({id: e.id, name: e.name, kind, baseURL: e.baseURL, models: e.model ? [e.model] : []}));
      }
    }
    return providers;
  }

  function providers() {
    let list;
    try {
      list = JSON.parse(pref('providers', 'null'));
    } catch (_) {
      list = null;
    }
    if (!Array.isArray(list)) {
      let old = [];
      try { old = JSON.parse(pref('engines', '[]')); } catch (_) {}
      list = migrateEngines(old);
      const defaultEngine = pref('defaultEngine', '');
      const migrated = list.find(p => p.id === defaultEngine);
      if (migrated && !pref('chatModel', '')) setPref('chatModel', C().modelRef(migrated.id, migrated.models[0] || ''));
      saveProviders(list);
    }
    return list.map(cleanProvider);
  }

  function saveProviders(list) {
    setPref('providers', JSON.stringify(list.map(cleanProvider)));
  }

  function provider(id) {
    return providers().find(p => p.id === id) || null;
  }

  function upsertProvider(next) {
    const list = providers();
    const i = list.findIndex(p => p.id === next.id);
    if (i >= 0) list[i] = cleanProvider(next);
    else list.push(cleanProvider(next));
    saveProviders(list);
    return cleanProvider(next);
  }

  async function removeProvider(id) {
    saveProviders(providers().filter(p => p.id !== id));
    await saveKey(id, '');
  }

  function newProviderID() {
    return 'api-' + g.Services.uuid.generateUUID().toString().replace(/[{}]/g, '');
  }

  // Every selectable model, API providers first (they are much faster).
  function modelChoices() {
    const choices = [];
    const list = providers().filter(p => p.enabled);
    list.sort((a, b) => Number(P().isAPI(b)) - Number(P().isAPI(a)));
    for (const p of list) {
      if (P().isAPI(p)) {
        if (!p.baseURL) continue;
        for (const m of p.models) choices.push({ref: C().modelRef(p.id, m), provider: p, model: m, label: p.modelNames[m] || m, group: p.name});
      } else {
        if (!p.path) continue;
        choices.push({ref: C().modelRef(p.id, ''), provider: p, model: '', label: p.name + ' · 默认模型', group: p.name});
        for (const m of p.models) choices.push({ref: C().modelRef(p.id, m), provider: p, model: m, label: p.name + ' · ' + (p.modelNames[m] || m), group: p.name});
      }
    }
    return choices;
  }

  // task: 'translate' | 'chat'. Falls back to the first usable model.
  function resolveModel(task) {
    const choices = modelChoices();
    const wanted = pref(task === 'translate' ? 'translateModel' : 'chatModel', '');
    return choices.find(c => c.ref === wanted) || choices[0] || null;
  }

  function chooseModel(task, ref) {
    setPref(task === 'translate' ? 'translateModel' : 'chatModel', ref);
  }

  // ---- secrets (Mozilla Login Manager, never in prefs or history) --------

  async function logins() {
    return g.Services.logins.searchLoginsAsync({origin: LOGIN_ORIGIN, httpRealm: LOGIN_REALM});
  }
  async function keyFor(id) {
    return (await logins()).find(x => x.username === id)?.password || '';
  }
  async function saveKey(id, key) {
    const old = (await logins()).find(x => x.username === id);
    if (!key) {
      if (old) g.Services.logins.removeLogin(old);
      return;
    }
    const LoginInfo = new g.Components.Constructor('@mozilla.org/login-manager/loginInfo;1', g.Ci.nsILoginInfo, 'init');
    const login = new LoginInfo(LOGIN_ORIGIN, null, LOGIN_REALM, id, key, '', '');
    if (old) g.Services.logins.modifyLogin(old, login);
    else await g.Services.logins.addLoginAsync(login);
  }

  // ---- local engines ----------------------------------------------------

  function home() {
    return g.Services.dirsvc.get('Home', g.Ci.nsIFile).path;
  }

  async function executablePaths(name) {
    const bins = (g.Services.env.get('PATH') || '').split(':').filter(Boolean);
    bins.push(g.PathUtils.join(home(), '.local', 'bin'), g.PathUtils.join(home(), '.opencode', 'bin'), '/opt/homebrew/bin', '/usr/local/bin');
    try {
      const nvm = g.PathUtils.join(home(), '.nvm', 'versions', 'node');
      const dirs = (await g.IOUtils.getChildren(nvm)).slice(0, 64).sort((a, b) => b.localeCompare(a, undefined, {numeric: true}));
      bins.unshift(...dirs.map(d => g.PathUtils.join(d, 'bin')));
    } catch (_) {}
    const result = [];
    for (const dir of new Set(bins)) {
      const path = g.PathUtils.join(dir, name);
      try {
        if ((await g.IOUtils.stat(path)).type === 'regular') result.push(path);
      } catch (_) {}
    }
    return result;
  }

  // Adds CLI providers for engines found on this Mac and repairs stale paths
  // (e.g. after an nvm upgrade removed the old node directory).
  async function discoverCLIs() {
    const list = providers();
    let changed = false;
    for (const kind of P().CLI_KINDS) {
      const found = await executablePaths(P().KINDS[kind].binary);
      let p = list.find(x => x.id === kind);
      let valid = false;
      if (p?.path) {
        try { valid = (await g.IOUtils.stat(p.path)).type === 'regular'; } catch (_) {}
      }
      if (!found.length || valid) continue;
      if (!p) {
        p = cleanProvider({id: kind, kind, name: {codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode'}[kind]});
        list.push(p);
      }
      p.path = found[0];
      changed = true;
    }
    if (changed) saveProviders(list);
    return list;
  }

  async function runtimePath(p) {
    const nodes = await executablePaths('node');
    return [g.PathUtils.parent(p.path), ...nodes.map(x => g.PathUtils.parent(x)), g.Services.env.get('PATH'),
      '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean).join(':');
  }

  async function codexModels(p, signal) {
    const {Subprocess} = g.ChromeUtils.importESModule('resource://gre/modules/Subprocess.sys.mjs');
    const proc = await Subprocess.call({command: p.path, arguments: ['app-server'], environmentAppend: true,
      environment: {PATH: await runtimePath(p), NO_COLOR: '1'}, stderr: 'pipe'});
    let resolve, reject;
    const pending = new Promise((a, b) => { resolve = a; reject = b; });
    const stop = () => { try { proc.kill(); } catch (_) {} };
    const abort = () => { reject(new Error('已停止读取模型')); stop(); };
    signal?.addEventListener('abort', abort, {once: true});
    const win = g.Zotero.getMainWindow();
    const timer = win.setTimeout(() => { reject(new Error('读取 Codex 模型超时')); stop(); }, 15000);
    const lines = new (P().LineBuffer)(line => {
      if (!line.trim()) return;
      const m = JSON.parse(line);
      if (m.id === 1) {
        if (m.error) return reject(new Error(m.error.message));
        proc.stdin.write(JSON.stringify({method: 'initialized', params: {}}) + '\n' +
          JSON.stringify({id: 2, method: 'model/list', params: {limit: 100, includeHidden: false}}) + '\n').catch(reject);
      }
      if (m.id === 2) {
        if (m.error) reject(new Error(m.error.message));
        else try { resolve(P().codexModelList(m.result)); } catch (e) { reject(e); }
      }
    });
    const output = (async () => {
      let chunk;
      while ((chunk = await proc.stdout.readString())) lines.push(chunk);
      reject(new Error('Codex 模型目录连接提前关闭'));
    })().catch(reject);
    const errors = (async () => { while (await proc.stderr.readString()); })().catch(() => {});
    try {
      await proc.stdin.write(JSON.stringify({id: 1, method: 'initialize',
        params: {clientInfo: {name: 'paper_companion', title: 'Paper Companion', version: '0.2.0'}}}) + '\n');
      return await pending;
    } finally {
      win.clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      stop();
      await Promise.allSettled([output, errors, proc.wait()]);
    }
  }

  // ---- OpenCode import --------------------------------------------------

  async function opencodeCandidates() {
    const dir = g.PathUtils.join(home(), '.config', 'opencode');
    const found = [];
    for (const name of ['opencode.json', 'opencode.jsonc']) {
      try {
        const raw = await g.IOUtils.readUTF8(g.PathUtils.join(dir, name));
        found.push(...P().opencodeCandidates(JSON.parse(P().stripJSONComments(raw))));
      } catch (_) {}
    }
    const existing = providers();
    const seen = new Set();
    return found.filter(c => {
      const id = c.kind + c.baseURL;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    }).map(c => ({...c, imported: existing.some(p => p.kind === c.kind && p.baseURL === c.baseURL)}));
  }

  async function importCandidate(c) {
    const existing = providers().find(p => p.kind === c.kind && p.baseURL === c.baseURL);
    const p = upsertProvider({...(existing || {}), id: existing?.id || newProviderID(), name: c.name, kind: c.kind,
      baseURL: c.baseURL, models: [...new Set([...(existing?.models || []), ...c.models])],
      modelNames: {...(existing?.modelNames || {}), ...(c.modelNames || {})}});
    await saveKey(p.id, c.key);
    return p;
  }

  // ---- papers -----------------------------------------------------------

  function getReader(body) {
    const details = body.closest('item-details');
    const tabID = details?.tabID || details?.dataset?.tabId;
    return tabID ? g.Zotero.Reader.getByTabID(tabID) : null;
  }

  function storageRoot() {
    return g.PathUtils.join(g.Zotero.DataDirectory.dir, 'paper-companion');
  }

  async function paperIdentity(itemID) {
    const item = await g.Zotero.Items.getAsync(itemID);
    if (!item?.isPDFAttachment()) throw new Error('请打开一份 PDF');
    const parent = item.parentItemID ? await g.Zotero.Items.getAsync(item.parentItemID) : null;
    return {item, title: parent?.getField('title') || item.getField('title') || '未命名论文',
      key: item.libraryID + '_' + item.key, hash: await item.attachmentHash};
  }

  function blockText(node, depth = 0) {
    if (depth > 16) return '';
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(x => blockText(x, depth + 1)).join('');
    if (!node || typeof node !== 'object') return '';
    if (typeof node.text === 'string') return node.text;
    if (typeof node.value === 'string' && /text/i.test(node.type || '')) return node.value;
    for (const key of ['content', 'children', 'runs', 'inlines', 'lines']) if (node[key]) return blockText(node[key], depth + 1);
    return '';
  }

  function sdtBlock(block, pageIndex, index) {
    const text = C().normalize(blockText(block));
    if (!text) return null;
    const rect = block.anchor?.pageRects?.find(r => Array.isArray(r) && r[0] === pageIndex && r.length === 5)?.slice(1) ||
      block.source?.rect || block.position?.rects?.[0];
    return {text, pageIndex, index, rect};
  }

  const packs = new Map();
  async function sdtPack(identity) {
    const key = identity.key + ':' + identity.hash;
    if (!packs.has(key)) {
      packs.set(key, (async () => {
        const pack = await g.Zotero.SDT.getReader(identity.item.id, {isPriority: true});
        if (!pack) return null;
        const catalog = await pack.getCatalog();
        return {pack, pageCount: catalog.pages?.length || 0, pages: new Map()};
      })().catch(e => { packs.delete(key); throw e; }));
      if (packs.size > 8) packs.delete(packs.keys().next().value);
    }
    return packs.get(key);
  }

  async function sdtPage(state, pageIndex) {
    if (!state.pages.has(pageIndex)) {
      state.pages.set(pageIndex, state.pack.getPageBlocks(pageIndex).then(list =>
        list.map((b, i) => sdtBlock(b, pageIndex, pageIndex * 10000 + i)).filter(Boolean)));
    }
    return state.pages.get(pageIndex);
  }

  async function pdftotextBlocks(identity, win, signal) {
    let binary = '';
    for (const p of ['/opt/homebrew/bin/pdftotext', '/usr/local/bin/pdftotext', '/usr/bin/pdftotext']) {
      try { if ((await g.IOUtils.stat(p)).type === 'regular') { binary = p; break; } } catch (_) {}
    }
    if (!binary) throw new Error('未能读取段落：此 PDF 可能是扫描件，或需要安装 pdftotext（brew install poppler）');
    const file = await identity.item.getFilePathAsync();
    if (!file) throw new Error('PDF 本地文件不可用');
    const xml = await collect(binary, ['-bbox-layout', '-enc', 'UTF-8', file, '-'], signal);
    const doc = new win.DOMParser().parseFromString(xml, 'application/xml');
    const pages = doc.getElementsByTagName('page');
    const blocks = [];
    for (let i = 0; i < pages.length; i++) {
      const height = Number(pages[i].getAttribute('height'));
      for (const b of pages[i].getElementsByTagName('block')) {
        const text = C().normalize([...b.getElementsByTagName('line')]
          .map(l => [...l.getElementsByTagName('word')].map(w => w.textContent).join(' ')).join('\n'));
        if (text) blocks.push({text, pageIndex: i, index: blocks.length, rect: [Number(b.getAttribute('xMin')),
          height - Number(b.getAttribute('yMax')), Number(b.getAttribute('xMax')), height - Number(b.getAttribute('yMin'))]});
      }
    }
    return {blocks, pageCount: pages.length};
  }

  async function collect(command, args, signal) {
    const {Subprocess} = g.ChromeUtils.importESModule('resource://gre/modules/Subprocess.sys.mjs');
    const proc = await Subprocess.call({command, arguments: args, stderr: 'pipe'});
    const stop = () => { try { proc.kill(); } catch (_) {} };
    signal?.addEventListener('abort', stop, {once: true});
    const win = g.Zotero.getMainWindow();
    const timer = win.setTimeout(stop, 120000);
    let output = '';
    let error = '';
    try {
      await Promise.all([
        (async () => { let s; while ((s = await proc.stdout.readString())) { output += s; if (output.length > 25e6) throw new Error('文档文本过大'); } })(),
        (async () => { let s; while ((s = await proc.stderr.readString())) error = (error + s).slice(-1000); })(),
      ]);
      const result = await proc.wait();
      if (signal?.aborted) throw new Error('已停止');
      if (result.exitCode !== 0) throw new Error('本地解析失败：' + C().redact(error));
      return output;
    } finally {
      stop();
      win.clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
    }
  }

  const papers = new Map();
  // Whole paper as paragraph blocks with page numbers (cached per file hash).
  async function readPaper(identity, win, signal) {
    const key = identity.key + ':' + identity.hash;
    if (papers.has(key)) return papers.get(key);
    let result = null;
    try {
      const state = await sdtPack(identity);
      if (state?.pageCount) {
        if (state.pageCount > 1000) throw new Error('论文超过 1000 页');
        const blocks = [];
        for (let i = 0; i < state.pageCount; i++) {
          if (signal?.aborted) throw new Error('已停止');
          blocks.push(...await sdtPage(state, i));
        }
        if (blocks.length) result = {blocks, pageCount: state.pageCount};
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      g.Zotero.debug('Paper Companion: SDT unavailable, falling back to pdftotext: ' + e);
    }
    if (!result) result = await pdftotextBlocks(identity, win, signal);
    if (!result.blocks.length) throw new Error('PDF 没有可提取的文字；扫描件需先 OCR');
    papers.set(key, result);
    if (papers.size > 6) papers.delete(papers.keys().next().value);
    return result;
  }

  // Only the selected page and its neighbours — enough to disambiguate a
  // translation without parsing the whole paper first.
  async function readAround(identity, pageIndex, win, signal) {
    const cached = papers.get(identity.key + ':' + identity.hash);
    if (cached) return cached.blocks;
    try {
      const state = await sdtPack(identity);
      if (state?.pageCount) {
        const pages = [pageIndex - 1, pageIndex, pageIndex + 1].filter(i => i >= 0 && i < state.pageCount);
        const blocks = (await Promise.all(pages.map(i => sdtPage(state, i)))).flat();
        if (blocks.length) return blocks;
      }
    } catch (e) {
      if (signal?.aborted) throw e;
    }
    return (await readPaper(identity, win, signal)).blocks;
  }

  // ---- chat history -----------------------------------------------------

  async function loadChat(key) {
    const dir = g.PathUtils.join(storageRoot(), key);
    try {
      const data = JSON.parse(await g.IOUtils.readUTF8(g.PathUtils.join(dir, 'chat.json')));
      if (Array.isArray(data.messages)) return data.messages.slice(-200);
    } catch (e) {
      if (e.name !== 'NotFoundError') g.Zotero.debug('Paper Companion: chat history unreadable: ' + e);
    }
    // 0.1.x kept one file per engine; start from the most recent one.
    let newest = null;
    try {
      for (const path of await g.IOUtils.getChildren(dir)) {
        if (!/\/(codex|claude|opencode|api-[\w-]+)\.json$/.test(path)) continue;
        const stat = await g.IOUtils.stat(path);
        if (!newest || stat.lastModified > newest.time) newest = {path, time: stat.lastModified};
      }
      if (newest) {
        const data = JSON.parse(await g.IOUtils.readUTF8(newest.path));
        return (data.messages || []).filter(m => ['user', 'assistant'].includes(m.role)).map(m => ({
          ...m, model: m.model || m.engineName || '', status: m.status || 'complete',
        })).slice(-200);
      }
    } catch (_) {}
    return [];
  }

  async function saveChat(key, messages) {
    const dir = g.PathUtils.join(storageRoot(), key);
    await g.IOUtils.makeDirectory(dir, {ignoreExisting: true, createAncestors: true});
    const path = g.PathUtils.join(dir, 'chat.json');
    await g.IOUtils.writeUTF8(path, JSON.stringify({version: 2, messages: messages.slice(-200)}), {tmpPath: path + '.tmp'});
  }

  async function archiveChat(key) {
    const path = g.PathUtils.join(storageRoot(), key, 'chat.json');
    try {
      await g.IOUtils.move(path, g.PathUtils.join(storageRoot(), key, `chat-${Date.now()}.json`));
    } catch (e) {
      if (e.name !== 'NotFoundError') throw e;
    }
  }

  async function workdir(key) {
    const dir = g.PathUtils.join(storageRoot(), key, 'runtime');
    await g.IOUtils.makeDirectory(dir, {ignoreExisting: true, createAncestors: true});
    return dir;
  }

  // Everything a provider call needs besides the prompt.
  async function runOptions(choice, {identityKey, signal, win, task, onText, onThinking}) {
    const p = choice.provider;
    const base = {signal, task, onText, onThinking, thinking: pref('chatThinking', false)};
    if (P().isAPI(p)) return {...base, key: await keyFor(p.id), fetch: win.fetch.bind(win), TextDecoder: win.TextDecoder};
    return {...base, workdir: await workdir(identityKey || '_shared'), path: await runtimePath(p)};
  }

  function clearCaches() {
    packs.clear();
    papers.clear();
  }

  const api = {
    PREFIX, pref, setPref, cleanProvider, migrateEngines, providers, saveProviders, provider, upsertProvider,
    removeProvider, newProviderID, modelChoices, resolveModel, chooseModel, keyFor, saveKey, executablePaths,
    discoverCLIs, runtimePath, codexModels, opencodeCandidates, importCandidate, getReader, paperIdentity,
    readPaper, readAround, loadChat, saveChat, archiveChat, workdir, runOptions, clearCaches,
  };
  g.PCServices = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
