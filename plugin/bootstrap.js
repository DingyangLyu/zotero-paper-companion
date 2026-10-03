var PaperCompanionPlugin;
async function startup({id, version, rootURI}) {
  await Zotero.uiReadyPromise;
  for (const file of ['vendor/katex/runtime.js','vendor/marked.js','core.js','engines.js','render.js','native.js','popup.js','main.js']) {
    Services.scriptloader.loadSubScript(rootURI+'content/'+file);
  }
  await PaperCompanionPlugin.init({id,version,rootURI});
  PaperCompanionPlugin.addToAllWindows();
}
function onMainWindowLoad({window}) {PaperCompanionPlugin?.addToWindow(window);}
function onMainWindowUnload({window}) {PaperCompanionPlugin?.removeFromWindow(window);}
async function shutdown() {await PaperCompanionPlugin?.shutdown();PaperCompanionPlugin=undefined;}
function install() {}
function uninstall() {}
