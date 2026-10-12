/* Paper Companion — translation card inside Zotero's text-selection popup.
 *
 * Jobs are separate from views: Zotero may re-render the popup (and call us
 * again) for the same selection, so a view attaches to the running job for
 * that selection instead of restarting it. A job without views is cancelled
 * after a short grace period. */
(function (g) {
  'use strict';
  const S = () => g.PCServices;
  const C = () => g.PCCore;
  const GRACE_MS = 1500;
  const CONTEXT_WAIT_MS = 2500;
  // The plugin sandbox has no AbortController of its own.
  const newController = () => new (g.AbortController || g.Zotero.getMainWindow().AbortController)();

  class Translator {
    constructor({run = null, maxDone = 60} = {}) {
      this.jobs = new Map();
      this.maxDone = maxDone;
      this.run = run || ((job, update) => this.translate(job, update));
    }

    keyFor(quote, ref, language) {
      return JSON.stringify([quote.itemID, quote.pageIndex, quote.text, ref, language]);
    }

    // Returns the job for this selection, starting one when needed.
    acquire(quote, {ref, language, label, force = false, start = true}) {
      const key = this.keyFor(quote, ref, language);
      let job = this.jobs.get(key);
      if (job && (force || job.status === 'error' || job.status === 'stopped')) {
        this.cancel(job);
        job = null;
      }
      if (!job) {
        job = {key, quote, ref, language, label, status: 'idle', text: '', note: '', error: '', views: new Set(), controller: null, idleTimer: null};
        this.jobs.set(key, job);
        this.prune();
      } else {
        // Refresh LRU position.
        this.jobs.delete(key);
        this.jobs.set(key, job);
      }
      if (start && job.status === 'idle') this.start(job);
      return job;
    }

    start(job) {
      job.status = 'running';
      job.text = '';
      job.error = '';
      job.note = '';
      job.controller = newController();
      this.emit(job);
      const update = patch => {
        if (job.controller?.signal.aborted && patch.status !== 'stopped') return;
        Object.assign(job, patch);
        this.emit(job);
      };
      Promise.resolve()
        .then(() => this.run(job, update))
        .then(text => update({status: 'done', text: text || job.text}))
        .catch(e => update(job.controller?.signal.aborted
          ? {status: 'stopped'}
          : {status: 'error', error: C().redact(e?.message || String(e))}))
        .finally(() => { job.controller = null; });
    }

    attach(job, view) {
      clearTimeout(job.idleTimer);
      job.idleTimer = null;
      job.views.add(view);
      view(job);
    }

    detach(job, view) {
      job.views.delete(view);
      if (!job.views.size && job.status === 'running') {
        clearTimeout(job.idleTimer);
        job.idleTimer = setTimeout(() => { if (!job.views.size) this.cancel(job); }, GRACE_MS);
      }
    }

    cancel(job) {
      clearTimeout(job.idleTimer);
      if (job.status === 'running') {
        job.controller?.abort();
        job.status = 'stopped';
      }
      if (this.jobs.get(job.key) === job && job.status !== 'done') this.jobs.delete(job.key);
    }

    emit(job) {
      for (const view of [...job.views]) {
        try { view(job); } catch (e) { g.Zotero?.debug?.('Paper Companion: view update failed: ' + e); }
      }
    }

    prune() {
      for (const [key, job] of this.jobs) {
        if (this.jobs.size <= this.maxDone) break;
        if (job.status !== 'running' && !job.views.size) this.jobs.delete(key);
      }
    }

    shutdown() {
      for (const job of this.jobs.values()) this.cancel(job);
      this.jobs.clear();
    }

    // The real translation, used inside Zotero.
    async translate(job, update) {
      const choice = S().modelChoices().find(c => c.ref === job.ref);
      if (!choice) throw new Error('还没有可用的翻译模型，请打开设置添加 API 或本机引擎');
      const signal = job.controller.signal;
      const win = g.Zotero.getMainWindow();
      // EPUB and web snapshots have no PDF text layer: translate without context.
      const identity = await S().paperIdentity(job.quote.itemID).catch(() => null);
      // Context helps with ambiguous terms, but never blocks the translation.
      let blocks = [];
      if (identity && job.quote.pageIndex != null) try {
        const around = await Promise.race([
          S().readAround(identity, job.quote.pageIndex, win, signal),
          new Promise(resolve => win.setTimeout(() => resolve(null), CONTEXT_WAIT_MS)),
        ]);
        if (around) {
          const context = C().contextFor(around, job.quote, S().pref('contextRadius', 1));
          blocks = context.found ? context.blocks : [];
        }
      } catch (e) {
        if (signal.aborted) throw e;
      }
      if (signal.aborted) throw new Error('已停止');
      update({note: blocks.length ? '' : '未使用上下文'});
      const prompt = C().translation({quote: job.quote, blocks, language: job.language, title: identity?.title || ''});
      let text = '';
      const opts = await S().runOptions(choice, {
        identityKey: identity?.key, signal, win, task: 'translate',
        onText: t => { text = t; update({text: t}); },
      });
      return g.PCProviders.run(choice.provider, choice.model, prompt, opts).then(t => t || text);
    }
  }

  class PopupUI {
    constructor(plugin) {
      this.plugin = plugin;
      this.translator = new Translator();
      this.views = new Set();
    }

    // Zotero's renderTextSelectionPopup handler. Must append synchronously.
    render({reader, doc, params, append}) {
      const quote = C().selection(params.annotation, reader.itemID);
      if (!quote) return;
      const p = this.plugin;
      const el = (tag, cls, text) => p.element(doc, tag, cls, text);
      const card = el('section', 'pc-card');
      card.setAttribute('aria-label', '论文助手翻译');
      const style = el('style');
      style.textContent = p.styles + (S().pref('hideOtherPopups', true)
        ? '\n.selection-popup:has(.pc-card) .custom-sections > .section:has(> .zoteropdftranslate-readerpopup){display:none!important}' : '');

      const head = el('div', 'pc-card-head');
      const models = el('select', 'pc-card-model');
      models.setAttribute('aria-label', '翻译模型');
      models.title = '翻译模型';
      const actions = el('div', 'pc-card-actions');
      const copy = p.button(doc, '复制', () => this.copy(view), 'pc-link');
      const redo = p.button(doc, '重译', () => this.go(view, true), 'pc-link');
      const explain = p.button(doc, '解释', () => p.askAbout(reader, quote, {question: '请结合上下文解释这段内容在论文中的含义。', send: true}), 'pc-link');
      const ask = p.button(doc, '提问', () => p.askAbout(reader, quote, {}), 'pc-link');
      explain.title = '在右侧论文助手中解释这段内容';
      ask.title = '把选区带到右侧论文助手，输入你的问题';
      actions.append(copy, redo);
      // Paper chat needs a PDF page; EPUB/snapshot selections only translate.
      if (quote.pageIndex != null) actions.append(explain, ask);
      head.append(models, actions);

      const body = el('div', 'pc-card-body');
      body.setAttribute('aria-live', 'polite');
      const status = el('div', 'pc-card-status');
      card.append(style, head, body, status);

      const view = {reader, doc, quote, card, models, body, status, copy, redo, job: null, update: null, disposed: false};
      this.fillModels(view);
      models.addEventListener('change', () => {
        if (models.value === '__settings__') {
          p.openSettings();
          this.fillModels(view);
          return;
        }
        S().chooseModel('translate', models.value);
        this.go(view, false);
      });

      // Keep the reader from treating clicks inside the card as a new selection.
      for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'keydown', 'dragstart']) {
        card.addEventListener(type, e => e.stopPropagation());
      }
      append(card);
      this.views.add(view);
      this.watch(view);

      if (S().pref('autoTranslate', true)) {
        this.go(view, false);
      } else {
        const start = p.button(doc, '翻译', () => { start.remove(); this.go(view, false); }, 'pc-primary');
        body.append(start);
        this.paintIdle(view);
      }
    }

    fillModels(view) {
      const p = this.plugin;
      const choices = S().modelChoices();
      const current = S().resolveModel('translate');
      view.models.replaceChildren();
      for (const c of choices) {
        const o = p.element(view.doc, 'option', null, c.label);
        o.value = c.ref;
        view.models.append(o);
      }
      const settings = p.element(view.doc, 'option', null, choices.length ? '模型设置…' : '添加模型…');
      settings.value = '__settings__';
      view.models.append(settings);
      view.models.value = current?.ref || '__settings__';
    }

    go(view, force) {
      if (view.disposed) return;
      const choice = S().resolveModel('translate');
      if (view.job) this.translator.detach(view.job, view.update);
      if (!choice) {
        view.job = null;
        view.body.replaceChildren();
        this.setStatus(view, '还没有可用的模型。', 'error', true);
        return;
      }
      view.update = job => this.paint(view, job);
      view.job = this.translator.acquire(view.quote, {
        ref: choice.ref, label: choice.label, language: S().pref('language', '简体中文'), force,
      });
      this.translator.attach(view.job, view.update);
    }

    paintIdle(view) {
      view.copy.disabled = true;
      view.redo.disabled = true;
      this.setStatus(view, '');
    }

    paint(view, job) {
      if (view.disposed || !view.card.isConnected && view.connected) return;
      const p = this.plugin;
      view.copy.disabled = !job.text;
      view.redo.disabled = job.status === 'running';
      if (job.text) {
        g.PCRender.render(view.doc, view.body, job.text, {pageCount: 0, sources: [], onExternal: url => g.Zotero.launchURL(url)});
      } else {
        view.body.replaceChildren();
      }
      if (job.status === 'running') {
        this.setStatus(view, job.text ? '' : '翻译中…', 'busy');
      } else if (job.status === 'error') {
        this.setStatus(view, job.error, 'error', /模型|设置|API|Key|地址|找到/.test(job.error));
      } else if (job.status === 'stopped') {
        this.setStatus(view, '已停止');
      } else if (job.status === 'done') {
        this.setStatus(view, job.note || '', 'muted');
      }
      this.fit(view);
      void p;
    }

    setStatus(view, text, kind = 'muted', withSettings = false) {
      view.status.replaceChildren();
      view.status.dataset.kind = kind;
      view.status.hidden = !text;
      if (!text) return;
      if (kind === 'busy') view.status.append(this.plugin.element(view.doc, 'span', 'pc-spinner'));
      view.status.append(this.plugin.element(view.doc, 'span', null, text));
      if (withSettings) view.status.append(this.plugin.button(view.doc, '打开设置', () => this.plugin.openSettings(), 'pc-link'));
    }

    copy(view) {
      if (!view.job?.text) return;
      this.plugin.copyText(view.job.text);
      view.copy.textContent = '已复制';
      setTimeout(() => { if (!view.disposed) view.copy.textContent = '复制'; }, 1200);
    }

    // The popup is positioned before the translation arrives; nudge it back
    // into the viewport as the card grows.
    fit(view) {
      const host = view.card.closest('.selection-popup');
      const win = view.doc.defaultView;
      if (!host || !win) return;
      const rect = host.getBoundingClientRect();
      const bounds = host.parentElement.getBoundingClientRect();
      const right = Math.min(bounds.right, win.innerWidth) - 8;
      const bottom = Math.min(bounds.bottom, win.innerHeight) - 8;
      const dx = rect.right > right ? right - rect.right : rect.left < bounds.left + 8 ? bounds.left + 8 - rect.left : 0;
      const dy = rect.bottom > bottom ? Math.max(bottom - rect.bottom, bounds.top + 8 - rect.top) : 0;
      const m = host.style.transform.match(/^translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)$/);
      if ((dx || dy) && m) host.style.transform = `translate(${Number(m[1]) + dx}px, ${Number(m[2]) + dy}px)`;
    }

    // Dispose the view once Zotero removes the card (popup closed or re-rendered).
    watch(view) {
      // Observers come from the main window: the reader document lives in a
      // content compartment whose constructors can't read our option objects.
      const Observer = g.Zotero.getMainWindow().MutationObserver;
      view.connected = view.card.isConnected;
      view.observer = new Observer(() => {
        if (view.card.isConnected) view.connected = true;
        else if (view.connected) this.dispose(view);
      });
      view.observer.observe(view.doc.body || view.doc.documentElement, {childList: true, subtree: true});
      // If Zotero never attaches the card (e.g. the popup closed immediately).
      view.attachTimer = g.Zotero.getMainWindow().setTimeout(() => { if (!view.card.isConnected) this.dispose(view); }, 3000);
    }

    dispose(view) {
      if (view.disposed) return;
      view.disposed = true;
      view.observer?.disconnect();
      g.Zotero.getMainWindow()?.clearTimeout(view.attachTimer);
      if (view.job) this.translator.detach(view.job, view.update);
      view.card.remove();
      this.views.delete(view);
    }

    shutdown() {
      for (const view of [...this.views]) this.dispose(view);
      this.translator.shutdown();
    }
  }

  g.PCTranslator = Translator;
  g.PCPopup = PopupUI;
  if (typeof module !== 'undefined') module.exports = {Translator, PopupUI};
})(globalThis);
