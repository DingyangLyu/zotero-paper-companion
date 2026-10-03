var PaperCompanionPlugin;
async function startup({id, version, rootURI}) {
  await Zotero.uiReadyPromise;
  for (const file of ['vendor/katex/runtime.js','vendor/marked.js','core.js','engines.js','render.js','native.js','popup.js','layout.js','main.js']) {
    Services.scriptloader.loadSubScriptWithOptions(rootURI+'content/'+file,{ignoreCache:true});
  }
  await PaperCompanionPlugin.init({id,version,rootURI});
  PaperCompanionPlugin.addToAllWindows();
}
function onMainWindowLoad({window}) {PaperCompanionPlugin?.addToWindow(window);}
function onMainWindowUnload({window}) {PaperCompanionPlugin?.removeFromWindow(window);}
async function shutdown() {await PaperCompanionPlugin?.shutdown();PaperCompanionPlugin=undefined;}
function install() {}
function uninstall() {}
