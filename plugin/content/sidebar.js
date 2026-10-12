/* Paper Companion — question answering in the reader's item pane.
 *
 * A conversation (its history and the request in flight) belongs to the
 * paper, not to the pane's DOM. Zotero can rebuild the pane at any time; a new
 * view simply re-attaches to the same conversation, so nothing a rebuild does
 * can drop or overwrite messages. Each question is written to disk as soon as
 * it is asked. */
(function (g) {
  'use strict';
  const S = () => g.PCServices;
  const C = () => g.PCCore;
  const newController = () => new (g.Zotero.getMainWindow().AbortController)();
  const SUGGESTIONS = ['总结这篇论文', '主要贡献和创新点是什么？', '方法具体是怎么做的？', '实验结果和局限性'];
  const IDLE_LIMIT = 120000; // nothing streamed for this long: give up
  const TOTAL_LIMIT = 600000;
  const MAX_SESSIONS = 24;

  class ChatPane {
    constructor(plugin) {
      this.plugin = plugin;
      this.views = new Map(); // pane body -> view
      this.sessions = new Map(); // paper key -> conversation
      this.drafts = new Map();
    }

    el(v, tag, cls, text) {
      return this.plugin.element(v.doc, tag, cls, text);
    }

    log(event, data) {
      try { S().log?.(event, data); } catch (_) {}
    }

    // ---- conversations ----------------------------------------------------

    session(key) {
      let s = this.sessions.get(key);
      if (s) {
        this.sessions.delete(key); // keep most recently used last
        this.sessions.set(key, s);
        return s;
      }
      s = {key, history: [], busy: false, live: null, controller: null, phase: '', started: 0, saving: Promise.resolve()};
      s.ready = S().loadChat(key).then(history => {
        s.history = history.map(m => (m.status === 'pending' ? {...m, status: 'error', error: '上次回答未完成'} : m));
      });
      s.ready.catch(() => { if (this.sessions.get(key) === s) this.sessions.delete(key); });
      this.sessions.set(key, s);
      for (const [k, old] of this.sessions) {
        if (this.sessions.size <= MAX_SESSIONS) break;
        if (!old.busy && !this.viewsOf(old).length) this.sessions.delete(k);
      }
      return s;
    }

    viewsOf(s) {
      return [...this.views.values()].filter(v => v.session === s && this.current(v));
    }

    save(s) {
      const messages = s.history.slice();
      s.saving = s.saving.then(() => S().saveChat(s.key, messages)).catch(e => {
        this.log('save-failed', {paper: s.key, error: e?.message || String(e)});
        for (const v of this.viewsOf(s)) this.setStatus(v, '保存对话失败：' + (e?.message || e), 'error');
      });
      return s.saving;
    }

    // ---- views ------------------------------------------------------------

    // ItemPaneManager onRender.
    render({doc, body}) {
      const reader = S().getReader(body);
      const item = reader && g.Zotero.Items.get(reader.itemID);
      if (!item?.isPDFAttachment()) {
        if (this.views.has(body)) this.log('pane-cleared', {reason: reader ? 'not-pdf' : 'no-reader'});
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
      const v = {doc, body, win: doc.defaultView, itemID: reader.itemID, tabID: reader.tabID, session: null, quote: null,
        destroyed: false, identity: null, liveNode: null};
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

      // Quote, status and composer stay together and stick to the bottom of
      // the item pane, so they remain visible however the pane is scrolled.
      const dock = this.el(v, 'div', 'pc-dock');
      v.quoteBox = this.el(v, 'div', 'pc-quote');
      v.quoteBox.hidden = true;
      v.status = this.el(v, 'div', 'pc-foot');
      v.status.setAttribute('role', 'status');
      v.status.hidden = true;

      const compose = this.el(v, 'div', 'pc-compose');
      v.input = this.el(v, 'textarea', 'pc-input');
      v.input.rows = 2;
      v.input.placeholder = '向这篇论文提问…';
      v.input.title = 'Enter 发送，Shift+Enter 换行';
      v.input.setAttribute('aria-label', '输入问题');
      // Some input methods deliver the Enter that confirms a candidate right
      // after compositionend; ignore Enter for a moment after composing.
      v.composedAt = 0;
      v.input.addEventListener('compositionend', () => { v.composedAt = Date.now(); });
      v.input.addEventListener('keydown', e => {
        if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        if (Date.now() - v.composedAt < 80) return;
        this.send(v);
      });
      v.input.addEventListener('input', () => this.autosize(v));
      v.sendButton = p.button(v.doc, '发送', () => (v.session?.busy ? this.stop(v) : this.send(v)), 'pc-primary pc-send');
      compose.append(v.input, v.sendButton);
      dock.append(v.quoteBox, v.status, compose);

      v.root.append(bar, v.list, dock);
      v.body.append(v.root);
      this.fillModels(v);
      this.paintThinking(v);
      this.paintQuote(v);
      this.paintEmpty(v, '正在载入对话…');
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
        if (v.session?.busy) continue;
        this.fillModels(v);
        this.paintThinking(v);
      }
    }

    // Fill the visible pane height (below our section header) so the whole
    // chat fits once Zotero scrolls to this section.
    fitHeight(v) {
      const viewport = v.body.closest('.zotero-view-item') || v.body.closest('item-details');
      const section = v.body.closest('item-pane-custom-section') || v.body;
      if (!viewport) return () => {};
      const update = () => {
        const h = viewport.clientHeight;
        const header = v.root.getBoundingClientRect().top - section.getBoundingClientRect().top;
        if (h > 0) v.root.style.setProperty('--pc-height', Math.max(360, Math.round(h - Math.max(0, header) - 40)) + 'px');
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
        if (!this.current(v)) return;
        const s = this.session(identity.key);
        await s.ready;
        if (!this.current(v)) return;
        v.identity = identity;
        v.session = s;
        this.paintHistory(v);
        this.setBusy(v);
        this.applyDraft(v);
      } catch (e) {
        this.log('load-failed', {item: v.itemID, error: e?.message || String(e)});
        if (this.current(v)) {
          this.paintEmpty(v, '载入对话失败');
          this.setStatus(v, '载入对话失败：' + (e?.message || e), 'error');
        }
      }
    }

    // A selection handed over from the popup ("解释" / "提问").
    applyDraft(v) {
      const draft = this.drafts.get(v.tabID);
      if (!draft || draft.quote.itemID !== v.itemID || !v.session) return;
      this.drafts.delete(v.tabID);
      v.quote = draft.quote;
      this.paintQuote(v);
      if (draft.send && !v.session.busy) {
        this.send(v, draft.question);
        return;
      }
      if (draft.send) this.setStatus(v, '上一个回答还在生成，选区已放入输入区');
      if (draft.question && !v.input.value.trim()) v.input.value = draft.question;
      this.autosize(v);
      v.input.focus();
    }

    ask(tabID, quote, options) {
      this.drafts.set(tabID, {quote, ...options});
      for (const v of this.views.values()) if (v.tabID === tabID) this.applyDraft(v);
    }

    // ---- painting ---------------------------------------------------------

    paintQuote(v) {
      v.quoteBox.replaceChildren();
      v.quoteBox.hidden = !v.quote;
      if (!v.quote) return;
      const head = this.el(v, 'div', 'pc-quote-head');
      const page = Number.isInteger(v.quote.pageIndex) ? ` · 第 ${v.quote.pageIndex + 1} 页` : '';
      head.append(this.el(v, 'span', null, '选区' + page));
      const remove = this.plugin.button(v.doc, '×', () => { v.quote = null; this.paintQuote(v); }, 'pc-quote-remove');
      remove.title = '移除选区';
      head.append(remove);
      v.quoteBox.append(head, this.el(v, 'div', 'pc-quote-text', v.quote.text));
    }

    paintEmpty(v, loading) {
      const empty = this.el(v, 'div', 'pc-empty');
      if (loading) {
        empty.append(this.el(v, 'div', 'pc-empty-hint', loading));
      } else {
        empty.append(this.el(v, 'div', 'pc-empty-title', '问问这篇论文'),
          this.el(v, 'div', 'pc-empty-hint', '在 PDF 中划选文字可以直接翻译；点「解释」或「提问」会把选区带到这里。'));
        const chips = this.el(v, 'div', 'pc-chips');
        for (const s of SUGGESTIONS) chips.append(this.plugin.button(v.doc, s, () => this.send(v, s), 'pc-chip'));
        empty.append(chips);
      }
      v.list.replaceChildren(empty);
    }

    paintHistory(v) {
      const s = v.session;
      v.liveNode = null;
      if (!s?.history.length) {
        this.paintEmpty(v);
        return;
      }
      const nodes = s.history.map(m => this.messageNode(v, m));
      v.list.replaceChildren(...nodes);
      v.list.scrollTop = v.list.scrollHeight;
    }

    messageNode(v, m) {
      const node = this.el(v, 'article', 'pc-msg');
      node.dataset.role = m.role;
      try {
        if (m.role === 'user') {
          if (m.quote?.text) node.append(this.el(v, 'blockquote', 'pc-msg-quote', m.quote.text));
          node.append(this.el(v, 'div', 'pc-msg-text', m.question || m.text || ''));
          return node;
        }
        const content = this.el(v, 'div', 'pc-msg-body');
        node.append(content);
        this.drawAnswer(v, content, m);
        if (m === v.session?.live) {
          v.liveNode = content;
          return node;
        }
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
      } catch (e) {
        // Never let one message take the whole conversation down with it.
        this.log('paint-failed', {role: m.role, error: e?.message || String(e)});
        node.replaceChildren(this.el(v, 'div', 'pc-msg-text pc-raw', m.text || ''));
      }
      return node;
    }

    drawAnswer(v, node, m) {
      const s = v.session;
      if (!m.text && m.status === 'pending') {
        const seconds = s?.started ? Math.floor((Date.now() - s.started) / 1000) : 0;
        const label = s?.phase === 'reading' ? '正在读取论文…' : m.thinking ? '思考中…' : '等待模型回复…';
        const text = ` ${label}${seconds >= 3 ? ` ${seconds} 秒` : ''}`;
        const muted = node.querySelector(':scope > .pc-spinner + .pc-muted');
        if (muted) muted.textContent = text; // keep the spinner animation running
        else node.replaceChildren(this.el(v, 'span', 'pc-spinner'), this.el(v, 'span', 'pc-muted', text));
        return;
      }
      try {
        g.PCRender.render(v.doc, node, m.text || '', {
          pageCount: m.pageCount || 0, sources: m.sources || [],
          onPage: pageIndex => { if (this.current(v)) g.Zotero.Reader.getByTabID(v.tabID).navigate({pageIndex}); },
          onExternal: url => g.Zotero.launchURL(url),
        });
      } catch (e) {
        this.log('render-failed', {error: e?.message || String(e)});
        node.textContent = m.text || '';
        node.classList.add('pc-raw');
      }
    }

    // Stream progress into every view of the conversation.
    paintLive(s) {
      for (const v of this.viewsOf(s)) {
        if (!v.liveNode?.isConnected) continue;
        const sel = v.win.getSelection();
        if (sel && !sel.isCollapsed && v.list.contains(sel.anchorNode)) continue;
        const nearBottom = v.list.scrollHeight - v.list.scrollTop - v.list.clientHeight < 120;
        this.drawAnswer(v, v.liveNode, s.live);
        if (nearBottom) v.list.scrollTop = v.list.scrollHeight;
      }
    }

    setStatus(v, text, kind = 'muted') {
      v.status.textContent = text ? C().redact(text).slice(0, 600) : '';
      v.status.dataset.kind = kind;
      v.status.hidden = !text;
    }

    setBusy(v) {
      const busy = !!v.session?.busy;
      v.sendButton.textContent = busy ? '停止' : '发送';
      v.sendButton.classList.toggle('pc-stop', busy);
      v.models.disabled = busy;
      v.newChat.disabled = busy;
      v.root.setAttribute('aria-busy', String(busy));
    }

    // ---- asking -----------------------------------------------------------

    async send(v, preset) {
      if (!this.current(v)) return;
      const s = v.session;
      if (!s) {
        this.setStatus(v, '正在载入对话，请稍候再发送');
        return;
      }
      if (s.busy) {
        this.setStatus(v, '上一个回答还在生成。可以等它完成，或点「停止」后再发送。');
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
      const identity = v.identity;
      const user = {role: 'user', text: (quote ? `> ${quote.text}\n\n` : '') + (question || '解释选区'), question, quote, status: 'complete', time: Date.now()};
      const answer = {role: 'assistant', text: '', status: 'pending', model: choice.label, time: Date.now()};
      const prior = s.history.slice();
      const win = g.Zotero.getMainWindow();
      const controller = newController();
      const signal = controller.signal;
      let lastActivity = Date.now();
      let timer = null;
      const redraw = () => {
        lastActivity = Date.now();
        if (timer) return;
        timer = win.setTimeout(() => { timer = null; this.paintLive(s); }, 60);
      };
      s.history.push(user, answer);
      Object.assign(s, {busy: true, live: answer, phase: 'reading', started: Date.now(), stalled: false, controller});
      // Once a second: refresh the waiting label and enforce the time limits.
      const watchdog = win.setInterval(() => {
        const now = Date.now();
        if (now - lastActivity > IDLE_LIMIT || now - s.started > TOTAL_LIMIT) {
          s.stalled = true;
          controller.abort();
        }
        if (!answer.text) this.paintLive(s);
      }, 1000);
      // From here on everything is inside try/finally, so the conversation
      // can never be left marked as busy.
      try {
        if (preset === undefined) v.input.value = '';
        this.autosize(v);
        v.quote = null;
        this.paintQuote(v);
        this.setStatus(v, '');
        for (const view of this.viewsOf(s)) {
          this.paintHistory(view);
          this.setBusy(view);
        }
        this.save(s);
        this.log('ask', {paper: s.key, model: choice.ref, quote: !!quote, history: prior.length});
        const paper = await S().readPaper(identity, win, signal);
        if (signal.aborted) throw new Error('已停止');
        const budget = g.PCProviders.isAPI(choice.provider) ? Number(S().pref('chatContextChars', 150000)) : 60000;
        const context = C().paperContext(paper.blocks, {budget, query: question + ' ' + (quote?.text || ''), focusPage: quote?.pageIndex ?? null});
        answer.sources = context.pages;
        answer.pageCount = paper.pageCount;
        answer.context = {pages: context.pages.length, chars: context.chars, complete: context.complete};
        const prompt = C().chat({paper: context, title: identity.title, language: S().pref('language', '简体中文'), history: prior, question, quote});
        answer.thinking = false;
        s.phase = 'waiting';
        redraw();
        const opts = await S().runOptions(choice, {
          identityKey: identity.key, signal, win, task: 'chat',
          onText: t => { answer.text = t; redraw(); },
          onThinking: () => { answer.thinking = true; redraw(); },
        });
        answer.text = await g.PCProviders.run(choice.provider, choice.model, prompt, opts);
        answer.status = 'complete';
      } catch (e) {
        if (s.stalled) {
          answer.status = 'error';
          answer.error = Date.now() - s.started > TOTAL_LIMIT ? '回答超过 10 分钟仍未完成，已中断。' :
            `模型服务 ${IDLE_LIMIT / 1000} 秒没有返回任何内容，已中断。可以点「重试」。`;
        } else if (signal.aborted) {
          answer.status = 'partial';
        } else {
          answer.status = 'error';
          answer.error = C().redact(e?.message || String(e));
        }
      } finally {
        win.clearInterval(watchdog);
        if (timer) win.clearTimeout(timer);
        delete answer.thinking;
        s.busy = false;
        s.live = null;
        s.controller = null;
        s.phase = '';
        this.log('answer', {paper: s.key, model: choice.ref, status: answer.status, ms: Date.now() - s.started,
          chars: answer.text.length, error: answer.error});
        for (const view of this.viewsOf(s)) {
          try {
            this.setBusy(view);
            if (view.status.dataset.kind !== 'error') this.setStatus(view, '');
            const nearBottom = view.list.scrollHeight - view.list.scrollTop - view.list.clientHeight < 120;
            const node = view.liveNode?.closest('.pc-msg');
            if (node?.isConnected) node.replaceWith(this.messageNode(view, answer));
            else this.paintHistory(view);
            view.liveNode = null;
            if (nearBottom) view.list.scrollTop = view.list.scrollHeight;
          } catch (e) {
            this.log('paint-failed', {error: e?.message || String(e)});
          }
        }
        await this.save(s);
      }
    }

    stop(v) {
      v.session?.controller?.abort();
    }

    retry(v, failed) {
      const s = v.session;
      if (!s || s.busy) return;
      const i = s.history.indexOf(failed);
      const user = s.history[i - 1];
      if (i < 1 || user?.role !== 'user') return;
      s.history.splice(i - 1, 2);
      v.quote = user.quote || null;
      this.send(v, user.question || (user.quote ? '' : user.text));
    }

    async reset(v) {
      const s = v.session;
      if (!s || s.busy || !s.history.length) return;
      s.history = [];
      v.quote = null;
      this.paintQuote(v);
      for (const view of this.viewsOf(s)) {
        this.paintHistory(view);
        this.setStatus(view, '');
      }
      try {
        await s.saving;
        await S().archiveChat(s.key);
      } catch (e) {
        this.setStatus(v, e.message, 'error');
      }
    }

    // A view going away never cancels its conversation's request; the answer
    // keeps streaming into the conversation and is saved when it finishes.
    destroy(body) {
      const v = this.views.get(body);
      if (!v) return;
      v.destroyed = true;
      v.cleanupLayout?.();
      body.classList.remove('pc-pane-body');
      this.views.delete(body);
    }

    destroyWindow(win) {
      for (const [body, v] of this.views) if (v.win === win) this.destroy(body);
    }

    shutdown() {
      for (const s of this.sessions.values()) s.controller?.abort();
      for (const body of [...this.views.keys()]) this.destroy(body);
      this.sessions.clear();
      this.drafts.clear();
    }
  }

  g.PCChatPane = ChatPane;
  if (typeof module !== 'undefined') module.exports = ChatPane;
})(globalThis);
