#!/bin/sh
# Rebuild the dev XPI and reinstall it into the running Zotero via the bridge.
set -e
cd "$(dirname "$0")/.."
npm run -s build:dev >/dev/null
XPI="$PWD/dist/$(node -p "'paper-companion-'+require('./plugin/manifest.json').version+'-dev.xpi'")"
TOKEN_FILE="$HOME/Zotero/paper-companion/.devbridge-token"
OLD=$(cat "$TOKEN_FILE")
dev/zeval.sh "
const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
const f=Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);f.initWithPath('$XPI');
const install=await AddonManager.getInstallForFile(f);
if(install.error||!install.addon?.isCompatible)throw new Error('XPI rejected: '+install.error);
setTimeout(()=>install.install(),50);
return 'installing';" >/dev/null
for i in $(seq 1 60); do
  NEW=$(cat "$TOKEN_FILE" 2>/dev/null || true)
  if [ -n "$NEW" ] && [ "$NEW" != "$OLD" ]; then echo "reloaded in ${i}s"; exit 0; fi
  sleep 1
done
echo "reload timed out" >&2; exit 1
