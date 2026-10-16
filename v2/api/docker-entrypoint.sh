#!/bin/sh
# Container entrypoint (runs under tini as PID 1).
#
# Back-compat for DENO_V8_FLAGS: deployments tuned the previous Deno runtime
# with comma-separated V8 flags, e.g.
#   DENO_V8_FLAGS=--max-old-space-size=768,--optimize-for-size
# Node takes the same V8 flags on its command line (NODE_OPTIONS only admits a
# subset), so when the command is `node ...` they are spliced in after it. An
# empty or unset value is a no-op. NODE_OPTIONS keeps working as usual.
set -eu

if [ -n "${DENO_V8_FLAGS:-}" ] && [ "${1:-}" = "node" ]; then
  shift
  # Word splitting is intended: one V8 flag per comma-separated entry.
  # shellcheck disable=SC2046
  set -- node $(printf '%s' "$DENO_V8_FLAGS" | tr ',' ' ') "$@"
fi

exec "$@"
