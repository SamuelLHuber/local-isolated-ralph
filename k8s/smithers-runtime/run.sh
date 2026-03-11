#!/bin/sh
set -eu

RUNTIME_DIR="${SMITHERS_RUNTIME_DIR:-/opt/smithers-runtime}"
WORKDIR="${SMITHERS_WORKDIR:-/workspace/workdir}"
DB_PATH="${SMITHERS_DB_PATH:-/workspace/.smithers/state.db}"
RUN_ID="${SMITHERS_RUN_ID:-local-run}"
WORKFLOW_PATH="${SMITHERS_WORKFLOW_PATH:-${RUNTIME_DIR}/workflow.tsx}"
SMITHERS_BIN="${SMITHERS_BIN:-${RUNTIME_DIR}/node_modules/.bin/smithers}"
PI_AGENT_DIR="${PI_CODING_AGENT_DIR:-/tmp/pi-agent}"
if [ "${SMITHERS_INPUT_JSON+x}" = "x" ]; then
  INPUT_JSON="$SMITHERS_INPUT_JSON"
else
  INPUT_JSON='{"goal":"hello"}'
fi

mkdir -p "$WORKDIR" "$(dirname "$DB_PATH")" "$PI_AGENT_DIR"

ensure_js_runtime() {
  target_dir="$1"
  mkdir -p "$target_dir"
  if [ ! -e "$target_dir/node_modules" ]; then
    ln -s "${RUNTIME_DIR}/node_modules" "$target_dir/node_modules"
  fi
  if [ ! -e "$target_dir/package.json" ]; then
    cp "${RUNTIME_DIR}/package.json" "$target_dir/package.json"
  fi
}

ensure_js_runtime "$WORKDIR"

WORKFLOW_DIR="$(dirname "$WORKFLOW_PATH")"
WORKFLOW_RUNTIME_DIR="$(dirname "$WORKFLOW_DIR")"
if [ "$WORKFLOW_RUNTIME_DIR" != "$WORKDIR" ]; then
  ensure_js_runtime "$WORKFLOW_RUNTIME_DIR"
fi

export PI_CODING_AGENT_DIR="$PI_AGENT_DIR"

if [ -n "${FIREWORKS_API_KEY:-}" ]; then
  cat >"${PI_AGENT_DIR}/models.json" <<'EOF'
{
  "providers": {
    "fireworks": {
      "baseUrl": "https://api.fireworks.ai/inference/v1",
      "api": "openai-completions",
      "apiKey": "FIREWORKS_API_KEY",
      "authHeader": true,
      "models": [
        {
          "id": "accounts/fireworks/models/kimi-k2p5",
          "name": "Fireworks Kimi K2.5",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 262144,
          "maxTokens": 32768,
          "cost": {
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0
          }
        }
      ]
    }
  }
}
EOF
fi

VCS_USER_NAME="${JJ_USER_NAME:-${GIT_AUTHOR_NAME:-${GIT_COMMITTER_NAME:-}}}"
VCS_USER_EMAIL="${JJ_USER_EMAIL:-${GIT_AUTHOR_EMAIL:-${GIT_COMMITTER_EMAIL:-}}}"
if [ -n "$VCS_USER_NAME" ] && [ -n "$VCS_USER_EMAIL" ]; then
  export GIT_AUTHOR_NAME="$VCS_USER_NAME"
  export GIT_COMMITTER_NAME="${GIT_COMMITTER_NAME:-$VCS_USER_NAME}"
  export GIT_AUTHOR_EMAIL="$VCS_USER_EMAIL"
  export GIT_COMMITTER_EMAIL="${GIT_COMMITTER_EMAIL:-$VCS_USER_EMAIL}"
  git config --global user.name "$VCS_USER_NAME"
  git config --global user.email "$VCS_USER_EMAIL"
  jj config set --user user.name "$VCS_USER_NAME" >/dev/null
  jj config set --user user.email "$VCS_USER_EMAIL" >/dev/null
fi

GITHUB_AUTH_TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
if [ -n "$GITHUB_AUTH_TOKEN" ]; then
  ASKPASS_PATH="/tmp/fabrik-git-askpass.sh"
  cat >"$ASKPASS_PATH" <<'EOF'
#!/bin/sh
case "$1" in
  *Username*) printf '%s\n' "x-access-token" ;;
  *Password*) printf '%s\n' "${GITHUB_AUTH_TOKEN:?}" ;;
  *) printf '\n' ;;
esac
EOF
  chmod 700 "$ASKPASS_PATH"
  export GITHUB_AUTH_TOKEN
  export GIT_ASKPASS="$ASKPASS_PATH"
  export GIT_TERMINAL_PROMPT=0
fi

cd "$WORKDIR"

if [ "$#" -gt 0 ]; then
  exec "$SMITHERS_BIN" "$@"
fi

exec "$SMITHERS_BIN" run "${WORKFLOW_PATH}" \
  --run-id "$RUN_ID" \
  --input "$INPUT_JSON" \
  --root "$WORKDIR"
