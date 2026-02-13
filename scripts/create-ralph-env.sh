#!/usr/bin/env bash
# Create or update ~/.config/ralph/ralph.env with common credentials
# Usage: ./create-ralph-env.sh

set -euo pipefail

ENV_DIR="${HOME}/.config/ralph"
ENV_FILE="${ENV_DIR}/ralph.env"

mkdir -p "$ENV_DIR"
chmod 700 "$ENV_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  cat > "$ENV_FILE" <<'EOF'
# Ralph shared environment (sourced by VM scripts)
# Add or update values as needed:
# export CLAUDE_CODE_OAUTH_TOKEN="..."
# export ANTHROPIC_API_KEY="..."
# export GITHUB_TOKEN="..."
# export GIT_AUTHOR_NAME="Your Name"
# export GIT_AUTHOR_EMAIL="you@example.com"
# export GIT_COMMITTER_NAME="Your Name"
# export GIT_COMMITTER_EMAIL="you@example.com"
#
# LAOS (Local Analytics and Observability Stack) - runs on host
# See: https://github.com/dtechvision/laos
# Docs: OBSERVABILITY.md in this repo
#
# Required: Set LAOS_HOST based on your platform
# macOS (Lima): export LAOS_HOST="host.lima.internal"
# Linux (libvirt): export LAOS_HOST="192.168.122.1"
#
# Telemetry endpoints (auto-configure from LAOS_HOST):
# export OTEL_EXPORTER_OTLP_ENDPOINT="http://${LAOS_HOST}:4317"
# export LOKI_URL="http://${LAOS_HOST}:3100"
# export SENTRY_DSN="http://<key>@${LAOS_HOST}:9000/1"
# export POSTHOG_HOST="http://${LAOS_HOST}:8001"
# export POSTHOG_API_KEY="phc_xxx"
# export PYROSCOPE_SERVER_ADDRESS="http://${LAOS_HOST}:4040"
EOF
  chmod 600 "$ENV_FILE"
  echo "Created $ENV_FILE"
else
  echo "Exists: $ENV_FILE"
fi

echo "Edit the file to add secrets, then re-run:"
echo "  ./scripts/sync-credentials.sh <vm-name>"
