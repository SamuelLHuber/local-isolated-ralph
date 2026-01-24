#!/usr/bin/env bash
#
# Verify Ralph VM setup
# Run inside the VM to verify all tools are installed correctly
#
# This script is for verification only - the NixOS image includes all tools.
# If something is missing, rebuild the image: cd nix && nix build .#qcow --rebuild
#
set -euo pipefail

echo "=== Ralph VM Verification ==="
echo ""

ERRORS=0

check_command() {
  local cmd="$1"
  local name="${2:-$1}"
  if command -v "$cmd" &>/dev/null; then
    local version
    version=$("$cmd" --version 2>/dev/null | head -1 || echo "installed")
    echo "[OK] $name: $version"
  else
    echo "[MISSING] $name"
    ERRORS=$((ERRORS + 1))
  fi
}

check_path_command() {
  local path="$1"
  local name="$2"
  if [[ -x "$path" ]]; then
    echo "[OK] $name: found at $path"
  elif command -v "$name" &>/dev/null; then
    echo "[OK] $name: $(command -v "$name")"
  else
    echo "[MISSING] $name (expected at $path)"
    ERRORS=$((ERRORS + 1))
  fi
}

echo ">>> Core Tools"
check_command git
check_command jj "jujutsu"
check_command tmux
check_command jq
check_command curl
check_command wget
check_command rg "ripgrep"
check_command fd
check_command htop

echo ""
echo ">>> Runtimes"
check_command node "Node.js"
check_command bun

echo ""
echo ">>> Agent CLIs"
check_path_command "$HOME/.bun/bin/claude" "claude"
check_path_command "$HOME/.bun/bin/codex" "codex"
check_path_command "$HOME/.bun/bin/opencode" "opencode"

if [[ ! -x "$HOME/.bun/bin/claude" ]]; then
  echo ""
  echo "Agent CLIs not found. Running install-agent-clis..."
  if command -v install-agent-clis &>/dev/null; then
    install-agent-clis
    echo ""
    echo "Re-checking agent CLIs..."
    check_path_command "$HOME/.bun/bin/claude" "claude"
    check_path_command "$HOME/.bun/bin/codex" "codex"
    check_path_command "$HOME/.bun/bin/opencode" "opencode"
  else
    echo "[ERROR] install-agent-clis command not found"
    ERRORS=$((ERRORS + 1))
  fi
fi

echo ""
echo ">>> Services"
if systemctl is-active --quiet docker 2>/dev/null; then
  echo "[OK] Docker: running"
else
  echo "[WARN] Docker: not running (start with: sudo systemctl start docker)"
fi

if systemctl is-active --quiet sshd 2>/dev/null; then
  echo "[OK] SSH: running"
else
  echo "[WARN] SSH: not running"
fi

echo ""
echo ">>> Credentials"

check_claude_auth() {
  if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    echo "[OK] Claude auth: ANTHROPIC_API_KEY set"
    return 0
  fi

  if [[ -f ~/.claude/.credentials.json ]]; then
    echo "[OK] Claude auth: credentials file found"
    return 0
  fi

  if [[ -d ~/.claude ]] && command -v claude &>/dev/null; then
    if claude --version &>/dev/null; then
      echo "[WARN] Claude auth: binary works but no credentials detected"
      echo "       Run 'claude setup-token' or set ANTHROPIC_API_KEY"
      return 1
    fi
  fi

  echo "[MISSING] Claude auth: not configured"
  echo "         Option 1: Set ANTHROPIC_API_KEY environment variable"
  echo "         Option 2: Run 'claude setup-token' for long-lived token"
  return 1
}

check_claude_auth || true

GIT_NAME=$(git config --global user.name 2>/dev/null || echo "")
GIT_EMAIL=$(git config --global user.email 2>/dev/null || echo "")
if [[ -n "$GIT_NAME" && -n "$GIT_EMAIL" ]]; then
  echo "[OK] Git identity: $GIT_NAME <$GIT_EMAIL>"
else
  echo "[WARN] Git identity: not configured (copy ~/.gitconfig from host)"
fi

if gh auth status &>/dev/null 2>&1; then
  echo "[OK] GitHub CLI: authenticated"
else
  echo "[WARN] GitHub CLI: not authenticated (copy ~/.config/gh from host)"
fi

if [[ -f ~/.ssh/id_ed25519 ]] || [[ -f ~/.ssh/id_rsa ]]; then
  echo "[OK] SSH keys: found"
else
  echo "[WARN] SSH keys: not found (copy from host for GitHub SSH access)"
fi

echo ""
echo ">>> Ralph Loop"
if [[ -x ~/ralph/loop.sh ]]; then
  echo "[OK] ralph-loop.sh: ~/ralph/loop.sh"
else
  echo "[MISSING] ralph-loop.sh: ~/ralph/loop.sh not found (copy from host)"
  ERRORS=$((ERRORS + 1))
fi

echo ""
echo ">>> Environment"
echo "PATH includes ~/.bun/bin: $(echo "$PATH" | grep -q '.bun/bin' && echo 'yes' || echo 'no')"
echo "RALPH_STATE_DIR: ${RALPH_STATE_DIR:-not set}"
echo "BUN_INSTALL: ${BUN_INSTALL:-not set}"

echo ""
echo "=== Summary ==="
if [[ $ERRORS -eq 0 ]]; then
  echo "All checks passed. VM is ready for use."
  echo ""
  echo "Quick start:"
  echo "  cd /workspace"
  echo "  ~/ralph/loop.sh ./PROMPT.md"
else
  echo "$ERRORS critical issues found. Check the output above."
  exit 1
fi
