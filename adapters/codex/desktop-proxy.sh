#!/bin/sh
# Only desktop embedded app-server launches use the framing bridge.
# Management commands and ordinary CLI commands keep their exact arguments.
set -eu
: "${ISSUECHAN_DESKTOP_CODEX_CLI:?Use the Start ChatGPT with Issue Channel.command launcher}"
for argument in "$@"; do
  if [ "$argument" = app-server ]; then
    case " $* " in
      *" daemon "*|*" proxy "*|*" generate-ts "*|*" generate-json-schema "*) exec "$ISSUECHAN_DESKTOP_CODEX_CLI" "$@" ;;
      *)
        here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
        exec "${ISSUECHAN_DESKTOP_NODE:-node}" "$here/desktop-bridge.mjs"
        ;;
    esac
  fi
done
exec "$ISSUECHAN_DESKTOP_CODEX_CLI" "$@"
