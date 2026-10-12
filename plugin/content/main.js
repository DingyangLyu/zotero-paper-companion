/* Paper Companion — plugin lifecycle and wiring between Zotero and the UI. */
var PaperCompanion = {
  id: null,
  version: null,
  rootURI: null,
  styles: '',
  paneID: null,
  prefsPaneID: null,
  windows: new Map(),
  observers: [],

  async init({id, version, rootURI}) {
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;
    this.styles = await Zotero.File.getResourceAsync(rootURI + 'content/style.css');
    this.popup = new PCPopup(this);
    this.chat = new PCChatPane(this);
    Zotero.PaperCompanion = this;

    PCServices.providers(); // migrates 0.1.x settings on first run
    this.selectionHandler = event => {
      try {
        this.popup.render(event);
      } catch (e) {
        Zotero.logError(e);
      }
    };
    Zotero.Reader.registerEventListener('renderTextSelectionPopup', this.selectionHandler, id);

    this.paneID = Zotero.ItemPaneManager.registerSection({
      paneID: 'paper-companion',
      pluginID: id,
      header: {l10nID: 'pc-pane-header', icon: rootURI + 'content/icon.svg'},
      sidenav: {l10nID: 'pc-pane-sidenav', icon: rootURI + 'content/icon.svg'},
      onInit: ({doc}) => this.addToWindow(doc.defaultView),
      onItemChange: ({tabType, setEnabled}) => setEnabled(tabType === 'reader'),
      onRender: props => this.chat.render(props),
      onDestroy: ({body}) => this.chat.destroy(body),
    });

    this.prefsPaneID = await Zotero.PreferencePanes.register({
      pluginID: id,
      id: 'paper-companion-prefs',
      src: rootURI + 'content/prefs.xhtml',
      stylesheets: [rootURI + 'content/prefs.css'],
      label: '论文助手',
      image: rootURI + 'content/icon.svg',
    });

    for (const name of ['providers', 'translateModel', 'chatModel']) {
      this.observers.push(Zotero.Prefs.registerObserver(PCServices.PREFIX + name, () => this.chat.refreshModels(), true));
    }
    // Engine discovery touches the file system; never block startup on it.
    PCServices.discoverCLIs().then(() => this.chat.refreshModels()).catch(e => Zotero.debug('Paper Companion: CLI discovery failed: ' + e));
  },

  addToAllWindows() {
    for (const win of Zotero.getMainWindows()) this.addToWindow(win);
  },

  addToWindow(win) {
    if (!win?.ZoteroPane || this.windows.has(win)) return;
    win.document.l10n?.addResourceIds(['paper-companion.ftl']);
    const style = win.document.createElementNS('http://www.w3.org/1999/xhtml', 'style');
    style.textContent = this.styles;
    win.document.documentElement.append(style);
    this.windows.set(win, {style});
  },

  removeFromWindow(win) {
    this.chat?.destroyWindow(win);
    this.windows.get(win)?.style.remove();
    win.document.l10n?.removeResourceIds(['paper-companion.ftl']);
    this.windows.delete(win);
  },

  element(doc, tag, cls, text) {
    const e = doc.createElementNS('http://www.w3.org/1999/xhtml', tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  },

  button(doc, text, action, cls) {
    const b = this.element(doc, 'button', cls, text);
    b.type = 'button';
    b.addEventListener('click', action);
    return b;
  },

  copyText(text) {
    Cc['@mozilla.org/widget/clipboardhelper;1'].getService(Ci.nsIClipboardHelper).copyString(text);
  },

  // From the popup: put a selection into the chat pane (and optionally ask).
  askAbout(reader, quote, options) {
    if (Zotero.Reader.getByTabID(reader.tabID)?.itemID !== quote.itemID) return;
    this.chat.ask(reader.tabID, quote, options);
    this.openPane(reader);
  },

  openPane(reader) {
    for (const win of Zotero.getMainWindows()) {
      const details = [...win.document.querySelectorAll('item-details')]
        .find(e => e.tabID === reader.tabID || e.dataset.tabId === reader.tabID);
      if (!details) continue;
      const parent = details.closest('context-pane, item-pane');
      if (parent && 'collapsed' in parent && parent.collapsed) parent.collapsed = false;
      if (typeof details.scrollToPane !== 'function') return;
      details.scrollToPane(this.paneID, 'smooth');
      // The chat grows to the pane height after it renders; align again then.
      win.setTimeout(() => details.scrollToPane(this.paneID, 'instant'), 400);
      return;
    }
  },

  openSettings() {
    Zotero.Utilities.Internal.openPreferences(this.prefsPaneID);
  },

  // Called from prefs.xhtml once Zotero inserts the pane.
  buildSettings(root) {
    return PCSettings.build(this, root);
  },

  async shutdown() {
    this.popup?.shutdown();
    this.chat?.shutdown();
    for (const id of this.observers) Zotero.Prefs.unregisterObserver(id);
    this.observers = [];
    if (this.paneID) Zotero.ItemPaneManager.unregisterSection(this.paneID);
    if (this.prefsPaneID) Zotero.PreferencePanes.unregister(this.prefsPaneID);
    Zotero.Reader.unregisterEventListener('renderTextSelectionPopup', this.selectionHandler);
    for (const win of [...this.windows.keys()]) this.removeFromWindow(win);
    PCServices.clearCaches();
    if (Zotero.PaperCompanion === this) delete Zotero.PaperCompanion;
  },
};
