/* Paper Companion — the pane in Zotero → Settings. */
(function (g) {
  'use strict';
  const S = () => g.PCServices;
  const P = () => g.PCProviders;
  const HTML = 'http://www.w3.org/1999/xhtml';

  function build(plugin, root) {
    const doc = root.ownerDocument;
    const win = doc.defaultView;
    const el = (tag, cls, text) => {
      const e = doc.createElementNS(HTML, tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    };
    const button = (text, action, cls) => {
      const b = el('button', cls, text);
      b.type = 'button';
      b.addEventListener('click', action);
      return b;
    };
    const field = (label, control, hint) => {
      const row = el('label', 'pcs-field');
      row.append(el('span', 'pcs-label', label), control);
      if (hint) row.append(el('span', 'pcs-hint', hint));
      return row;
    };
    const checkbox = (label, name, fallback) => {
      const row = el('label', 'pcs-check');
      const input = el('input');
      input.type = 'checkbox';
      input.checked = !!S().pref(name, fallback);
      input.addEventListener('change', () => S().setPref(name, input.checked));
      row.append(input, el('span', null, label));
      return row;
    };
    const select = (options, value, onChange) => {
      const s = el('select');
      for (const [v, text] of options) {
        const o = el('option', null, text);
        o.value = String(v);
        s.append(o);
      }
      s.value = String(value);
      s.addEventListener('change', () => onChange(s.value));
      return s;
    };

    const mount = el('div', 'pcs');
    root.replaceChildren(mount);

    function modelSelect(task) {
      const choices = S().modelChoices();
      const current = S().resolveModel(task);
      if (!choices.length) return el('span', 'pcs-warn', '还没有可用模型，请在下方添加 API 或检测本机 CLI');
      return select(choices.map(c => [c.ref, (P().isAPI(c.provider) ? '' : '⏱ ') + c.group + ' · ' + c.label]), current?.ref,
        v => { S().chooseModel(task, v); });
    }

    function draw() {
      mount.replaceChildren();

      const translate = el('section', 'pcs-section');
      translate.append(el('h2', null, '划词翻译'));
      translate.append(field('翻译模型', modelSelect('translate'), '翻译关闭了「深度思考」，优先速度；⏱ 表示本机 CLI，会明显更慢。'));
      const language = el('input');
      language.value = S().pref('language', '简体中文');
      language.addEventListener('change', () => S().setPref('language', language.value.trim() || '简体中文'));
      translate.append(field('翻译 / 回答语言', language));
      translate.append(checkbox('划词后自动翻译（关闭后需点「翻译」）', 'autoTranslate', true));
      translate.append(field('消歧上下文', select([[1, '选区所在段落及前后各 1 段'], [2, '选区所在段落及前后各 2 段']],
        S().pref('contextRadius', 1), v => S().setPref('contextRadius', Number(v)))));
      translate.append(checkbox('隐藏 Translate for Zotero 在同一弹窗里的翻译区', 'hideOtherPopups', true));

      const chat = el('section', 'pcs-section');
      chat.append(el('h2', null, '论文问答'));
      chat.append(field('问答模型', modelSelect('chat')));
      chat.append(field('论文上下文上限', select([[60000, '约 6 万字符'], [150000, '约 15 万字符（推荐）'], [400000, '约 40 万字符（长上下文模型）']],
        S().pref('chatContextChars', 150000), v => S().setPref('chatContextChars', Number(v))),
      '论文不超过上限时整篇发送，超出时按问题挑选相关段落。本机 CLI 固定使用 6 万字符。'));
      chat.append(checkbox('问答默认开启深度思考（更严谨，但首字通常多等 10 秒以上；也可在侧栏随时切换）', 'chatThinking', false));

      const reading = el('section', 'pcs-section');
      reading.append(el('h2', null, '阅读器'));
      reading.append(checkbox('右侧面板展开、收起或调整宽度时，自动缩放 PDF，保持铺满左侧的阅读区', 'fitPDFWidth', true));
      reading.append(el('p', 'pcs-hint', '只作用于固定缩放比例且原本铺满宽度的 PDF；Zotero「视图 → 适应页宽 / 自动缩放」模式本身就会自动适配，特意放大查看局部时也不会改动。'));

      const providers = el('section', 'pcs-section');
      providers.append(el('h2', null, '模型服务'));
      providers.append(el('p', 'pcs-hint', 'API 服务直接流式返回，速度最快；本机 CLI 每次都要启动一个完整的 Agent，通常需要 10–30 秒。API Key 保存在 Zotero 的密码管理器里。'));
      const list = el('div', 'pcs-providers');
      const all = S().providers().sort((a, b) => Number(P().isAPI(b)) - Number(P().isAPI(a)));
      for (const p of all) list.append(providerRow(p));
      providers.append(list);
      const tools = el('div', 'pcs-row');
      tools.append(
        button('添加 API 服务', () => editProvider({id: S().newProviderID(), name: '', kind: 'anthropic', baseURL: '', models: []}, true), 'pcs-primary'),
        button('从 OpenCode 导入', () => showImports(), null),
        button('重新检测本机 CLI', async () => { await S().discoverCLIs(); draw(); }, null),
      );
      providers.append(tools);
      providers.append(importBox);
      mount.append(translate, chat, reading, providers);
    }

    function providerRow(p) {
      const row = el('div', 'pcs-provider');
      row.dataset.id = p.id;
      const info = el('div', 'pcs-provider-info');
      info.append(el('div', 'pcs-provider-name', p.name), el('div', 'pcs-hint', P().KINDS[p.kind].label + ' · ' + (P().isAPI(p) ? p.baseURL || '未填写地址' : p.path || '未找到可执行文件')));
      info.append(el('div', 'pcs-hint', p.models.length ? '模型：' + p.models.join('、') : P().isAPI(p) ? '⚠ 未填写模型' : '使用 CLI 默认模型'));
      const result = el('div', 'pcs-result');
      const actions = el('div', 'pcs-row');
      actions.append(
        button('测试', () => test(p, result), null),
        button('编辑', () => editProvider(p, false), null),
        button('删除', async () => {
          if (!win.confirm(`删除「${p.name}」？` + (P().isAPI(p) ? '已保存的 API Key 也会删除。' : ''))) return;
          await S().removeProvider(p.id);
          draw();
        }, 'pcs-danger'),
      );
      row.append(info, actions, result);
      return row;
    }

    async function test(p, out) {
      const model = p.models[0] || '';
      out.className = 'pcs-result';
      out.textContent = '测试中…';
      const started = Date.now();
      const controller = new win.AbortController();
      const timer = win.setTimeout(() => controller.abort(), 90000);
      try {
        const choice = {provider: p, model};
        const prompt = g.PCCore.translation({quote: {text: 'Attention is all you need.', pageIndex: 0}, language: S().pref('language', '简体中文')});
        const opts = await S().runOptions(choice, {signal: controller.signal, win: g.Zotero.getMainWindow(), task: 'translate', onText: () => {}});
        const text = await P().run(p, model, prompt, opts);
        out.classList.add('pcs-ok');
        out.textContent = `✓ ${((Date.now() - started) / 1000).toFixed(1)} 秒 · ${text.trim().slice(0, 80)}`;
      } catch (e) {
        out.classList.add('pcs-error');
        out.textContent = '✗ ' + (controller.signal.aborted ? '超时' : g.PCCore.redact(e.message || e));
      } finally {
        win.clearTimeout(timer);
      }
    }

    function editProvider(p, isNew) {
      const form = el('div', 'pcs-form');
      const name = el('input');
      name.value = p.name;
      name.placeholder = '例如 Kimi K3';
      form.append(field('名称', name));
      let kind = null, baseURL = null, key = null, path = null;
      if (P().isAPI(p)) {
        kind = select(Object.entries(P().KINDS).filter(([, k]) => k.api).map(([id, k]) => [id, k.label]), p.kind, () => {});
        form.append(field('接口类型', kind));
        baseURL = el('input');
        baseURL.value = p.baseURL;
        baseURL.placeholder = 'https://api.example.com/v1';
        form.append(field('Base URL', baseURL, '填写到 /v1 一级即可，不要包含 /messages 或 /chat/completions。'));
        key = el('input');
        key.type = 'password';
        key.autocomplete = 'off';
        key.placeholder = isNew ? 'API Key' : '已保存的 Key 不显示；留空保持不变';
        form.append(field('API Key', key));
      } else {
        path = el('input');
        path.value = p.path;
        const browse = button('浏览…', async () => {
          const {FilePicker} = g.ChromeUtils.importESModule('chrome://zotero/content/modules/filePicker.mjs');
          const picker = new FilePicker();
          picker.init(win, '选择 ' + p.name, picker.modeOpen);
          if (await picker.show() === picker.returnOK) path.value = picker.file;
        });
        const line = el('div', 'pcs-row');
        line.append(path, browse);
        form.append(field('可执行文件', line));
      }
      const models = el('input');
      models.value = p.models.join(', ');
      models.placeholder = P().isAPI(p) ? '例如 k3, k3-256k' : '可留空，使用 CLI 默认模型';
      form.append(field('模型（逗号分隔）', models, P().isAPI(p) ? '第一个模型用于「测试」。' : ''));
      const status = el('div', 'pcs-result');
      const actions = el('div', 'pcs-row');
      if (p.kind === 'codex') {
        actions.append(button('读取 Codex 模型目录', async () => {
          status.textContent = '读取中…';
          try {
            const list = await S().codexModels({...p, path: path.value.trim() || p.path});
            models.value = list.map(m => m.id).join(', ');
            p.modelNames = Object.fromEntries(list.map(m => [m.id, m.name]));
            status.textContent = `读取到 ${list.length} 个模型`;
          } catch (e) {
            status.textContent = '✗ ' + e.message;
          }
        }));
      }
      actions.append(button('保存', async () => {
        try {
          const next = {...p, name: name.value.trim() || p.name || '自定义 API', models: models.value.split(/[,，\s]+/).filter(Boolean)};
          if (kind) {
            next.kind = kind.value;
            next.baseURL = baseURL.value.trim();
            P().endpoint(next);
            if (!next.models.length) throw new Error('请至少填写一个模型名称');
            if (isNew && !key.value.trim()) throw new Error('请填写 API Key');
          } else {
            next.path = path.value.trim();
            if (!g.PathUtils.isAbsolute(next.path)) throw new Error('请填写可执行文件的绝对路径');
          }
          const saved = S().upsertProvider(next);
          if (key?.value.trim()) await S().saveKey(saved.id, key.value.trim());
          if (isNew && !S().pref('translateModel', '')) S().chooseModel('translate', g.PCCore.modelRef(saved.id, saved.models[0]));
          draw();
        } catch (e) {
          status.className = 'pcs-result pcs-error';
          status.textContent = e.message;
        }
      }, 'pcs-primary'), button('取消', () => draw()));
      form.append(actions, status);
      const row = mount.querySelector(`.pcs-provider[data-id="${p.id}"]`);
      if (row) row.replaceWith(form);
      else mount.querySelector('.pcs-providers').append(form);
      name.focus();
    }

    const importBox = el('div', 'pcs-imports');
    async function showImports() {
      importBox.replaceChildren(el('div', 'pcs-hint', '正在读取 ~/.config/opencode …'));
      const found = await S().opencodeCandidates();
      importBox.replaceChildren();
      if (!found.length) {
        importBox.append(el('div', 'pcs-hint', '没有在 OpenCode 配置中找到带 baseURL 和 apiKey 的服务。'));
        return;
      }
      importBox.append(el('div', 'pcs-hint', '以下服务来自 OpenCode 配置。导入会把它的 Key 复制到 Zotero 密码管理器。'));
      for (const c of found) {
        const row = el('div', 'pcs-provider');
        const info = el('div', 'pcs-provider-info');
        info.append(el('div', 'pcs-provider-name', c.name), el('div', 'pcs-hint', P().KINDS[c.kind].label + ' · ' + c.baseURL + ' · ' + c.models.join('、')));
        row.append(info, button(c.imported ? '更新' : '导入', async () => {
          const p = await S().importCandidate(c);
          if (!S().pref('translateModel', '') || !S().resolveModel('translate') || !P().isAPI(S().resolveModel('translate').provider)) {
            S().chooseModel('translate', g.PCCore.modelRef(p.id, p.models[0]));
          }
          if (!P().isAPI(S().resolveModel('chat')?.provider || {})) S().chooseModel('chat', g.PCCore.modelRef(p.id, p.models[0]));
          importBox.replaceChildren();
          draw();
        }, 'pcs-primary'));
        importBox.append(row);
      }
    }

    draw();
    return {redraw: draw};
  }

  g.PCSettings = {build};
  if (typeof module !== 'undefined') module.exports = g.PCSettings;
})(globalThis);
