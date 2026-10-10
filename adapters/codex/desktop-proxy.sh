#!/bin/sh
# Only desktop embedded app-server launches use the framing bridge.
# Management commands and ordinary CLI commands keep their exact arguments.
set -eu
: "${ISSUECHAN_DESKTOP_CODEX_CLI:?Use the start-chatgpt-with-issuechan.command launcher}"
# Look at the argument right after "app-server" (not at substrings of all arguments, which a value like
# `-c key="a daemon b"` would match): management subcommands pass through, the bare server goes to the bridge.
seen=''
for argument in "$@"; do
  if [ -n "$seen" ]; then
    case $argument in
      daemon|proxy|generate-ts|generate-json-schema) exec "$ISSUECHAN_DESKTOP_CODEX_CLI" "$@" ;;
    esac
    break
  fi
  [ "$argument" = app-server ] && seen=1
done
if [ -n "$seen" ]; then
  here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  exec "${ISSUECHAN_DESKTOP_NODE:-node}" "$here/desktop-bridge.mjs"
fi
exec "$ISSUECHAN_DESKTOP_CODEX_CLI" "$@"
