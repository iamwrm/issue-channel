#!/bin/sh
# Completely quit ChatGPT first. This leaves the installed app and config unchanged.
set -eu
app=${ISSUECHAN_CHATGPT_APP:-/Applications/ChatGPT.app}
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export ISSUECHAN_DESKTOP_CODEX_CLI="$app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"
export ISSUECHAN_DESKTOP_NODE=${ISSUECHAN_NODE_BIN:-$(command -v node || true)}
if [ -z "$ISSUECHAN_DESKTOP_NODE" ] || ! "$ISSUECHAN_DESKTOP_NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
  echo 'issuechan: Node 24+ is required. Set ISSUECHAN_NODE_BIN to its absolute path.' >&2
  exit 1
fi
if [ ! -x "$ISSUECHAN_DESKTOP_CODEX_CLI" ] || [ ! -x "$app/Contents/MacOS/ChatGPT" ]; then
  echo 'issuechan: ChatGPT.app was not found. Set ISSUECHAN_CHATGPT_APP to its installation path.' >&2
  exit 1
fi
if [ ! -d "$here/../../node_modules/ws" ]; then
  echo 'issuechan: run npm ci in the issue-channel checkout first.' >&2
  exit 1
fi
"$ISSUECHAN_DESKTOP_CODEX_CLI" app-server daemon start
export CODEX_CLI_PATH="$here/desktop-proxy.sh"
exec "$app/Contents/MacOS/ChatGPT" "$@"
