#!/bin/sh
set -eu

codex_home=${CODEX_HOME:-/var/lib/codex}
seed_auth=/run/codex-seed/auth.json

install -d -m 0700 -o hypermail -g hypermail "$codex_home"
if [ ! -e "$codex_home/auth.json" ] && [ -f "$seed_auth" ]; then
  install -m 0600 -o hypermail -g hypermail "$seed_auth" "$codex_home/auth.json"
fi

exec su-exec hypermail "$@"
