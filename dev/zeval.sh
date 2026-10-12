#!/bin/sh
# Run JavaScript inside Zotero through a dev build's bridge.
# Usage: dev/zeval.sh 'return Zotero.version'   or   dev/zeval.sh -f script.js
TOKEN=$(cat "$HOME/Zotero/paper-companion/.devbridge-token") || exit 1
if [ "$1" = "-f" ]; then BODY=$(cat "$2"); else BODY="$1"; fi
curl -sS --noproxy '*' -m "${ZEVAL_TIMEOUT:-120}" -X POST http://127.0.0.1:23119/paper-companion-dev/eval \
  -H "X-PC-Token: $TOKEN" -H 'Content-Type: text/plain' --data-binary "$BODY"
echo
