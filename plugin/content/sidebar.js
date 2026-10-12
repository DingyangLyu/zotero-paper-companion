/* Paper Companion — question answering in the reader's item pane. */
(function (g) {
  'use strict';
  const S = () => g.PCServices;
  const C = () => g.PCCore;
  const newController = () => new (g.Zotero.getMainWindow().AbortController)();
  const SUGGESTIONS = ['总结这篇论文', '主要贡献和创新点是什么？', '方法具体是怎么做的？', '实验结果和局限性'];

  class ChatPane {
    constructor(plugin) {
      this.plugin = plugin;
      this.views = new Map();
      this.drafts = new Map();
    }

    el(v, tag, cls, text) {
      return this.plugin.element(v.doc, tag, cls, text);
    }

    // ItemPaneManager onRender.
    render({doc, body}) {
      const reader = S().getReader(body);
      const item = reader && g.Zotero.Items.get(reader.itemID);
      if (!item?.isPDFAttachment()) {
        this.destroy(body);
        body.textContent = '在阅读器中打开 PDF 后即可使用论文助手。';
        return;
      }
      const existing = this.views.get(body);
      if (existing?.itemID === reader.itemID) {
        this.applyDraft(existing);
        return;
      }
      this.destroy(body);
      body.replaceChildren();
      const v = {doc, body, win: doc.defaultView, itemID: reader.itemID, tabID: reader.tabID, history: [], quote: null,
        busy: false, loaded: false, destroyed: false, controller: null, identity: null};
      this.build(v);
      this.views.set(body, v);
      this.load(v);
    }

    build(v) {
      const p = this.plugin;
      v.root = this.el(v, 'div', 'pc-chat');
      v.body.classList.add('pc-pane-body');

      const bar = this.el(v, 'div', 'pc-bar');
      v.models = this.el(v, 'select', 'pc-model');
      v.models.setAttribute('aria-label', '问答模型');
      v.models.addEventListener('change', () => {
        if (v.models.value === '__settings__') {
          p.openSettings();
          this.fillModels(v);
          return;
        }
        S().chooseModel('chat', v.models.value);
      });
      v.thinking = p.button(v.doc, '深度思考', () => {
        S().setPref('chatThinking', !S().pref('chatThinking', false));
        this.paintThinking(v);
      }, 'pc-toggle');
      v.thinking.title = '开启后模型先推理再回答：更严谨，但首字通常要多等 10 秒以上';
      v.newChat = p.button(v.doc, '新对话', () => this.reset(v), 'pc-ghost');
      v.newChat.title = '清空当前对话（旧对话会保存为归档文件）';
      const settings = p.button(v.doc, '设置', () => p.openSettings(), 'pc-ghost');
      settings.title = '打开论文助手设置';
      const picker = this.el(v, 'span', 'pc-picker');
      picker.append(v.models);
      bar.append(picker, v.thinking, v.newChat, settings);

      v.list = this.el(v, 'div', 'pc-list');
      v.list.setAttribute('aria-label', '论文对话');
      v.list.setAttribute('role', 'log');

      v.quoteBox = this.el(v, 'div', 'pc-quote');
      v.quoteBox.hidden = true;

      const compose = this.el(v, 'div', 'pc-compose');
      v.input = this.el(v, 'textarea', 'pc-input');
      v.input.rows = 2;
      v.input.placeholder = '向这篇论文提问…';
      v.input.title = 'Enter 发送，Shift+Enter 换行';
      v.input.setAttribute('aria-label', '输入问题');
      v.input.addEventListener('keydown', e => {
        if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        this.send(v);
      });
      v.input.addEventListener('input', () => this.autosize(v));
      v.sendButton = p.button(v.doc, '发送', () => (v.busy ? v.controller?.abort() : this.send(v)), 'pc-primary pc-send');
      compose.append(v.input, v.sendButton);

      v.status = this.el(v, 'div', 'pc-foot');
      v.status.setAttribute('role', 'status');

      v.root.append(bar, v.list, v.quoteBox, compose, v.status);
      v.body.append(v.root);
      this.fillModels(v);
      this.paintThinking(v);
      this.paintQuote(v);
      this.paintHistory(v);
      v.cleanupLayout = this.fitHeight(v);
    }

    fillModels(v) {
      const choices = S().modelChoices();
      const current = S().resolveModel('chat');
      v.models.replaceChildren();
      const groups = new Map();
      for (const c of choices) {
        if (!groups.has(c.group)) {
          const og = this.el(v, 'optgroup');
          og.label = c.group;
          groups.set(c.group, og);
          v.models.append(og);
        }
        const o = this.el(v, 'option', null, c.label);
        o.value = c.ref;
        groups.get(c.group).append(o);
      }
      const settings = this.el(v, 'option', null, choices.length ? '管理模型…' : '添加模型…');
      settings.value = '__settings__';
      v.models.append(settings);
      v.models.value = current?.ref || '__settings__';
      v.models.title = current ? current.group + ' · ' + current.label : '还没有可用模型';
    }

    paintThinking(v) {
      const on = !!S().pref('chatThinking', false);
      v.thinking.setAttribute('aria-pressed', String(on));
      v.thinking.textContent = (on ? '✓ ' : '') + '深度思考';
      v.thinking.hidden = !S().resolveModel('chat') || !g.PCProviders.isAPI(S().resolveModel('chat').provider);
    }

    refreshModels() {
      for (const v of this.views.values()) {
        if (v.busy) continue;
        this.fillModels(v);
        this.paintThinking(v);
      }
    }

    // Fill the visible pane height (below our section header) so the
    // composer stays on screen once Zotero scrolls to this section.
    fitHeight(v) {
      const viewport = v.body.closest('.zotero-view-item') || v.body.closest('item-details');
      const section = v.body.closest('item-pane-custom-section') || v.body;
      if (!viewport) return () => {};
      const update = () => {
        const h = viewport.clientHeight;
        const header = v.root.getBoundingClientRect().top - section.getBoundingClientRect().top;
        if (h > 0) v.root.style.setProperty('--pc-height', Math.max(360, Math.round(h - Math.max(0, header) - 16)) + 'px');
      };
      const observer = new v.win.ResizeObserver(update);
      observer.observe(viewport);
      update();
      return () => observer.disconnect();
    }

    autosize(v) {
      v.input.style.height = 'auto';
      v.input.style.height = Math.min(160, Math.max(44, v.input.scrollHeight + 2)) + 'px';
    }

    current(v) {
      return !v.destroyed && !v.win.closed && this.views.get(v.body) === v &&
        g.Zotero.Reader.getByTabID(v.tabID)?.itemID === v.itemID;
    }

    async load(v) {
      try {
        const identity = await S().paperIdentity(v.itemID);
        const history = await S().loadChat(identity.key);
        if (!this.current(v)) return;
        v.identity = identity;
        v.history = history.map(m => (m.status === 'pending' ? {...m, status: 'error', error: '上次回答未完成'} : m));
        v.loaded = true;
        this.paintHistory(v);
        this.applyDraft(v);
      } catch (e) {
        if (this.current(v)) this.setStatus(v, e.message, 'error');
      }
    }

    // A selection handed over from the popup ("解释" / "提问").
    applyDraft(v) {
      const draft = this.drafts.get(v.tabID);
      if (!draft || draft.quote.itemID !== v.itemID || !v.loaded) return;
      this.drafts.delete(v.tabID);
      if (v.busy) {
        this.setStatus(v, '上一个回答还在生成，选区已放入输入区');
      }
      v.quote = draft.quote;
      this.paintQuote(v);
      if (draft.send && !v.busy) {
        this.send(v, draft.question);
      } else {
        if (draft.question) v.input.value = draft.question;
        this.autosize(v);
        v.input.focus();
      }
    }

    ask(tabID, quote, options) {
      this.drafts.set(tabID, {quote, ...options});
      for (const v of this.views.values()) if (v.tabID === tabID) this.applyDraft(v);
    }

    paintQuote(v) {
      v.quoteBox.replaceChildren();
      v.quoteBox.hidden = !v.quote;
      if (!v.quote) return;
      const head = this.el(v, 'div', 'pc-quote-head');
      head.append(this.el(v, 'span', null, `选区 · 第 ${v.quote.pageIndex + 1} 页`));
      const remove = this.plugin.button(v.doc, '×', () => { v.quote = null; this.paintQuote(v); }, 'pc-quote-remove');
      remove.title = '移除选区';
      head.append(remove);
      v.quoteBox.append(head, this.el(v, 'div', 'pc-quote-text', v.quote.text));
    }

    paintHistory(v) {
      v.list.replaceChildren();
      if (!v.history.length) {
        const empty = this.el(v, 'div', 'pc-empty');
        empty.append(this.el(v, 'div', 'pc-empty-title', '问问这篇论文'),
          this.el(v, 'div', 'pc-empty-hint', '在 PDF 中划选文字可以直接翻译；点「解释」或「提问」会把选区带到这里。'));
        const chips = this.el(v, 'div', 'pc-chips');
        for (const s of SUGGESTIONS) chips.append(this.plugin.button(v.doc, s, () => this.send(v, s), 'pc-chip'));
        empty.append(chips);
        v.list.append(empty);
        return;
      }
      for (const m of v.history) v.list.append(this.messageNode(v, m));
      v.list.scrollTop = v.list.scrollHeight;
    }

    messageNode(v, m) {
      const node = this.el(v, 'article', 'pc-msg');
      node.dataset.role = m.role;
      if (m.role === 'user') {
        if (m.quote?.text) node.append(this.el(v, 'blockquote', 'pc-msg-quote', m.quote.text));
        node.append(this.el(v, 'div', 'pc-msg-text', m.question ?? m.text));
        return node;
      }
      const content = this.el(v, 'div', 'pc-msg-body');
      node.append(content);
      this.drawAnswer(v, content, m);
      const meta = this.el(v, 'div', 'pc-msg-meta');
      const bits = [m.model || ''];
      if (m.context) bits.push(m.context.complete ? `全文 ${m.context.pages} 页` : `节选 ${m.context.pages} 页`);
      if (m.status === 'error') bits.push('未完成');
      if (m.status === 'partial') bits.push('已停止');
      meta.append(this.el(v, 'span', null, bits.filter(Boolean).join(' · ')));
      if (m.text) {
        const copy = this.plugin.button(v.doc, '复制', () => {
          this.plugin.copyText(m.text);
          copy.textContent = '已复制';
          v.win.setTimeout(() => { copy.textContent = '复制'; }, 1200);
        }, 'pc-link');
        meta.append(copy);
      }
      if (m.status === 'error' || m.status === 'partial') meta.append(this.plugin.button(v.doc, '重试', () => this.retry(v, m), 'pc-link'));
      node.append(meta);
      if (m.status === 'error' && m.error) node.append(this.el(v, 'div', 'pc-msg-error', m.error));
      return node;
    }

    drawAnswer(v, node, m) {
      if (!m.text && m.status === 'pending') {
        node.replaceChildren(this.el(v, 'span', 'pc-spinner'), this.el(v, 'span', 'pc-muted', m.thinking ? ' 思考中…' : ' 正在读取论文…'));
        return;
      }
      g.PCRender.render(v.doc, node, m.text || '', {
        pageCount: m.pageCount || 0, sources: m.sources || [],
        onPage: pageIndex => { if (this.current(v)) g.Zotero.Reader.getByTabID(v.tabID).navigate({pageIndex}); },
        onExternal: url => g.Zotero.launchURL(url),
      });
    }

    setStatus(v, text, kind = 'muted') {
      v.status.textContent = text ? C().redact(text).slice(0, 600) : '';
      v.status.dataset.kind = kind;
      v.status.hidden = !text;
    }

    setBusy(v, busy) {
      v.busy = busy;
      v.sendButton.textContent = busy ? '停止' : '发送';
      v.sendButton.classList.toggle('pc-stop', busy);
      v.models.disabled = busy;
      v.newChat.disabled = busy;
      v.root.setAttribute('aria-busy', String(busy));
    }

    async send(v, preset) {
      if (v.busy || !this.current(v)) return;
      if (!v.loaded) {
        this.setStatus(v, '正在载入对话，请稍候');
        return;
      }
      const question = String(preset ?? v.input.value).trim();
      const quote = v.quote;
      if (!question && !quote) return;
      const choice = S().resolveModel('chat');
      if (!choice) {
        this.setStatus(v, '还没有可用的模型，请先在设置中添加 API 或本机引擎', 'error');
        this.plugin.openSettings();
        return;
      }
      const user = {role: 'user', text: (quote ? `> ${quote.text}\n\n` : '') + (question || '解释选区'), question, quote, status: 'complete', time: Date.now()};
      const answer = {role: 'assistant', text: '', status: 'pending', model: choice.label, time: Date.now()};
      const prior = v.history.slice();
      v.history.push(user, answer);
      if (preset === undefined) v.input.value = '';
      this.autosize(v);
      v.quote = null;
      this.paintQuote(v);
      this.paintHistory(v);
      this.setStatus(v, '');
      const node = v.list.lastElementChild.querySelector('.pc-msg-body');
      this.setBusy(v, true);
      v.controller = newController();
      const signal = v.controller.signal;
      const timeout = v.win.setTimeout(() => v.controller?.abort(), 600000);
      let timer = null;
      const redraw = () => {
        if (timer) return;
        timer = v.win.setTimeout(() => {
          timer = null;
          if (!this.current(v)) return;
          const sel = v.win.getSelection();
          if (sel && !sel.isCollapsed && v.list.contains(sel.anchorNode)) return;
          const nearBottom = v.list.scrollHeight - v.list.scrollTop - v.list.clientHeight < 120;
          this.drawAnswer(v, node, answer);
          if (nearBottom) v.list.scrollTop = v.list.scrollHeight;
        }, 60);
      };
      try {
        const identity = v.identity || await S().paperIdentity(v.itemID);
        const paper = await S().readPaper(identity, v.win, signal);
        if (signal.aborted) throw new Error('已停止');
        const budget = g.PCProviders.isAPI(choice.provider) ? Number(S().pref('chatContextChars', 150000)) : 60000;
        const context = C().paperContext(paper.blocks, {budget, query: question + ' ' + (quote?.text || ''), focusPage: quote?.pageIndex ?? null});
        answer.sources = context.pages;
        answer.pageCount = paper.pageCount;
        answer.context = {pages: context.pages.length, chars: context.chars, complete: context.complete};
        const prompt = C().chat({paper: context, title: identity.title, language: S().pref('language', '简体中文'), history: prior, question, quote});
        answer.thinking = false;
        redraw();
        const opts = await S().runOptions(choice, {
          identityKey: identity.key, signal, win: v.win, task: 'chat',
          onText: t => { answer.text = t; redraw(); },
          onThinking: () => { answer.thinking = true; redraw(); },
        });
        answer.text = await g.PCProviders.run(choice.provider, choice.model, prompt, opts);
        answer.status = 'complete';
      } catch (e) {
        answer.status = signal.aborted ? 'partial' : 'error';
        if (!signal.aborted) answer.error = C().redact(e?.message || String(e));
      } finally {
        v.win.clearTimeout(timeout);
        if (timer) v.win.clearTimeout(timer);
        v.controller = null;
        if (!v.destroyed) {
          this.setBusy(v, false);
          if (this.current(v)) {
            const nearBottom = v.list.scrollHeight - v.list.scrollTop - v.list.clientHeight < 120;
            v.list.lastElementChild?.replaceWith(this.messageNode(v, answer));
            if (nearBottom) v.list.scrollTop = v.list.scrollHeight;
          }
        }
        if (v.identity) {
          try {
            await S().saveChat(v.identity.key, v.history);
          } catch (e) {
            if (!v.destroyed) this.setStatus(v, '回答已生成，但保存对话失败：' + e.message, 'error');
          }
        }
      }
    }

    retry(v, failed) {
      if (v.busy) return;
      const i = v.history.indexOf(failed);
      const user = v.history[i - 1];
      if (i < 1 || user?.role !== 'user') return;
      v.history.splice(i - 1, 2);
      v.quote = user.quote || null;
      this.send(v, user.question ?? user.text);
    }

    async reset(v) {
      if (v.busy || !v.history.length) return;
      v.history = [];
      v.quote = null;
      this.paintQuote(v);
      this.paintHistory(v);
      this.setStatus(v, '');
      if (v.identity) {
        try { await S().archiveChat(v.identity.key); } catch (e) { this.setStatus(v, e.message, 'error'); }
      }
    }

    destroy(body) {
      const v = this.views.get(body);
      if (!v) return;
      v.destroyed = true;
      v.controller?.abort();
      v.cleanupLayout?.();
      body.classList.remove('pc-pane-body');
      this.views.delete(body);
    }

    destroyWindow(win) {
      for (const [body, v] of this.views) if (v.win === win) this.destroy(body);
    }

    shutdown() {
      for (const body of [...this.views.keys()]) this.destroy(body);
      this.drafts.clear();
    }
  }

  g.PCChatPane = ChatPane;
  if (typeof module !== 'undefined') module.exports = ChatPane;
})(globalThis);
