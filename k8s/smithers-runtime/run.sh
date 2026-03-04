#!/bin/sh
set -eu

RUNTIME_DIR="${SMITHERS_RUNTIME_DIR:-/opt/smithers-runtime}"
WORKDIR="${SMITHERS_WORKDIR:-/workspace/workdir}"
DB_PATH="${SMITHERS_DB_PATH:-/workspace/.smithers/state.db}"
RUN_ID="${SMITHERS_RUN_ID:-local-run}"
if [ "${SMITHERS_INPUT_JSON+x}" = "x" ]; then
  INPUT_JSON="$SMITHERS_INPUT_JSON"
else
  INPUT_JSON='{"goal":"hello"}'
fi

mkdir -p "$WORKDIR" "$(dirname "$DB_PATH")"
cd "$WORKDIR"

if [ "$#" -gt 0 ]; then
  exec smithers "$@"
fi

exec smithers run "${RUNTIME_DIR}/workflow.tsx" \
  --run-id "$RUN_ID" \
  --input "$INPUT_JSON" \
  --root "$WORKDIR"
