/* Paper Companion — keep a fixed-zoom PDF fitted to its column.
 *
 * Zotero's right-hand pane takes width from the reader's view, but a PDF at a
 * fixed zoom (e.g. 210%) keeps its size, so the right part of the page ends
 * up behind the pane and has to be re-zoomed by hand after every open/close.
 * When the view width changes and the page was filling the width before, we
 * rescale it so it fills the new width the same way. Zotero's own "page
 * width" / "automatic" zoom modes already refit and are left alone, as is a
 * page the reader has zoomed into on purpose. */
(function (g) {
  'use strict';
  const MIN_CHANGE = 24; // px of view width change worth acting on
  const MAX_FILL = 0.985; // an overflowing page is brought back to this share

  // Pure decision. page: current page width; prevView: view width the page
  // was last seen at; view: the new view width. Returns a scale or null.
  function nextScale({scale, page, prevView, view}) {
    if (!(scale > 0 && page > 0 && prevView > 0 && view > 0)) return null;
    if (Math.abs(view - prevView) < MIN_CHANGE) return null;
    const fill = page / prevView;
    if (fill < 0.8 || fill > 1.1) return null; // narrow page or deliberate zoom-in
    const next = scale * ((fill > 1 ? MAX_FILL : fill) * view) / page;
    return Math.abs(next - scale) < 0.005 ? null : Math.min(10, Math.max(0.1, next));
  }

  class PDFFit {
    constructor() {
      this.views = new WeakMap(); // reader -> view width last seen
      this.windows = new Map();
      this.observerID = g.Zotero.Notifier.registerObserver({
        notify: (event, type) => {
          if (type !== 'tab' || !['select', 'load'].includes(event)) return;
          for (const win of this.windows.keys()) this.schedule(win, 600);
        },
      }, ['tab'], 'paper-companion-pdffit');
    }

    enabled() {
      return g.PCServices.pref('fitPDFWidth', true) !== false;
    }

    addWindow(win) {
      if (this.windows.has(win)) return;
      const doc = win.document;
      const targets = [doc.getElementById('zotero-context-pane'), doc.getElementById('tabs-deck')].filter(Boolean);
      const observer = new win.ResizeObserver(() => this.schedule(win));
      for (const t of targets) observer.observe(t);
      this.windows.set(win, {observer, timer: null});
    }

    removeWindow(win) {
      const w = this.windows.get(win);
      if (!w) return;
      w.observer.disconnect();
      win.clearTimeout(w.timer);
      this.windows.delete(win);
    }

    // The reader learns about the pane asynchronously; measure once it settled.
    schedule(win, delay = 350) {
      const w = this.windows.get(win);
      if (!w) return;
      win.clearTimeout(w.timer);
      w.timer = win.setTimeout(() => {
        try {
          this.check(win);
        } catch (e) {
          g.PCServices.log?.('pdffit-failed', {error: e?.message || String(e)});
        }
      }, delay);
    }

    measure(reader) {
      const internal = reader?._internalReader;
      const app = internal?._primaryView?._iframeWindow?.PDFViewerApplication;
      const viewer = app?.pdfViewer;
      if (!viewer?.container || !viewer.pagesCount) return null;
      const page = viewer.getPageView(Math.max(0, viewer.currentPageNumber - 1));
      return {
        viewer,
        auto: !!(internal.zoomAutoEnabled || internal.zoomPageWidthEnabled || internal.zoomPageHeightEnabled) ||
          typeof viewer.currentScaleValue === 'string' && !/^[\d.]+$/.test(viewer.currentScaleValue),
        spread: viewer.spreadMode > 0,
        scale: viewer.currentScale,
        page: page?.width || 0,
        view: viewer.container.clientWidth,
      };
    }

    check(win) {
      const reader = g.Zotero.Reader.getByTabID(win.Zotero_Tabs?.selectedID);
      if (!reader || reader.type && reader.type !== 'pdf') return;
      const m = this.measure(reader);
      if (!m || !m.view) return;
      const prevView = this.views.get(reader);
      this.views.set(reader, m.view);
      if (!prevView || m.auto || m.spread || !this.enabled()) return;
      const scale = nextScale({scale: m.scale, page: m.page, prevView, view: m.view});
      if (scale === null) return;
      m.viewer.currentScale = scale;
      g.PCServices.log?.('pdffit', {from: Math.round(m.scale * 100), to: Math.round(scale * 100), view: m.view, prevView});
    }

    shutdown() {
      for (const win of [...this.windows.keys()]) this.removeWindow(win);
      g.Zotero.Notifier.unregisterObserver(this.observerID);
    }
  }

  PDFFit.nextScale = nextScale;
  g.PCPDFFit = PDFFit;
  if (typeof module !== 'undefined') module.exports = PDFFit;
})(globalThis);
