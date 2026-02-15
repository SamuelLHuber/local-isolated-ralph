#!/usr/bin/env bash
# Validate and fix ~/.config/ralph/ralph.env
# Ensures all variables are properly exported

set -euo pipefail

ENV_FILE="${HOME}/.config/ralph/ralph.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: $ENV_FILE not found"
  echo "Run: ./scripts/create-ralph-env.sh"
  exit 1
fi

echo "Checking $ENV_FILE..."

# Check for variables without export
unexported=$(grep -E '^[A-Z_]+=' "$ENV_FILE" | grep -v '^export' || true)

if [[ -n "$unexported" ]]; then
  echo ""
  echo "⚠️  Found variables without 'export' keyword:"
  echo "$unexported"
  echo ""
  echo "This will cause 401 errors - child processes won't see these variables."
  echo ""
  read -p "Fix by adding 'export' to all variables? [Y/n] " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]] || [[ -z "$REPLY" ]]; then
    # Add export to lines that don't have it
    sed -i.bak 's/^\([A-Z_][A-Z0-9_]*=\)/export \1/' "$ENV_FILE"
    echo "✅ Fixed! Backup saved to $ENV_FILE.bak"
    echo ""
    echo "Verify with:"
    echo "  source ~/.config/ralph/ralph.env"
    echo "  env | grep -E 'FIREWORKS|MOONSHOT'"
  else
    echo "Not fixed. Remember: variables must be exported to work with Pi/Codex/Claude agents."
  fi
else
  echo "✅ All variables properly exported"
fi

# Check for required variables
echo ""
echo "Checking required credentials..."

source "$ENV_FILE" 2>/dev/null || true

missing=()
[[ -z "${GITHUB_TOKEN:-}" ]] && missing+=("GITHUB_TOKEN")
[[ -z "${FIREWORKS_API_KEY:-}" && -z "${API_KEY_MOONSHOT:-}" && -z "${ANTHROPIC_API_KEY:-}" ]] && missing+=("FIREWORKS_API_KEY or API_KEY_MOONSHOT or ANTHROPIC_API_KEY")

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "⚠️  Missing: ${missing[*]}"
  echo "Add these to $ENV_FILE"
else
  echo "✅ Required credentials present"
fi
