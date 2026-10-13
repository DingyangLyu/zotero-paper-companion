var PaperCompanion;

const SCRIPTS = ['vendor/katex/runtime.js', 'vendor/marked.js', 'core.js', 'providers.js', 'services.js', 'render.js',
  'popup.js', 'sidebar.js', 'pdffit.js', 'settings.js', 'main.js'];

async function startup({id, version, rootURI}) {
  await Zotero.uiReadyPromise;
  for (const file of SCRIPTS) {
    Services.scriptloader.loadSubScriptWithOptions(rootURI + 'content/' + file, {ignoreCache: true});
  }
  await PaperCompanion.init({id, version, rootURI});
  PaperCompanion.addToAllWindows();
  // Development builds only: a token-protected local test endpoint.
  try {
    Services.scriptloader.loadSubScriptWithOptions(rootURI + 'content/devbridge.js', {ignoreCache: true});
  } catch (_) {}
}

function onMainWindowLoad({window}) {
  PaperCompanion?.addToWindow(window);
}

function onMainWindowUnload({window}) {
  PaperCompanion?.removeFromWindow(window);
}

async function shutdown() {
  globalThis.PCDevBridge?.stop();
  await PaperCompanion?.shutdown();
  PaperCompanion = undefined;
}

function install() {}
function uninstall() {}
