#!/usr/bin/env bash
#
# Setup script for Ralph base VM
# Run inside a fresh VM to install all tools and configure for autonomous agent work
#
# Prerequisites:
#   - Fresh Ubuntu VM (created by create-ralph.sh)
#   - Auth folders should already be copied by create-ralph.sh
#
# After running this script, snapshot the VM as a template for fast cloning
#
set -euo pipefail

echo "=== Ralph Base VM Setup ==="
echo ""

# Install system packages
echo ">>> Installing system packages..."
sudo apt-get update
sudo apt-get install -y \
  git \
  curl \
  wget \
  jq \
  tmux \
  docker.io \
  build-essential \
  inotify-tools \
  unzip

# Docker setup
echo ">>> Configuring Docker..."
sudo systemctl enable --now docker
sudo usermod -aG docker $USER

# Node.js via nvm
echo ">>> Installing Node.js..."
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
export NVM_DIR="$HOME/.nvm"
source "$NVM_DIR/nvm.sh"
nvm install 20

# GitHub CLI
echo ">>> Installing GitHub CLI..."
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
sudo apt-get update
sudo apt-get install -y gh

# Jujutsu (jj) - recommended for parallel agent work
echo ">>> Installing Jujutsu (jj)..."
JJ_VERSION="0.24.0"
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  JJ_ARCH="x86_64-unknown-linux-musl" ;;
  aarch64) JJ_ARCH="aarch64-unknown-linux-musl" ;;
  *)
    echo "Note: Unsupported architecture $ARCH for jj, skipping..."
    JJ_ARCH=""
    ;;
esac
if [[ -n "$JJ_ARCH" ]]; then
  curl -fsSL "https://github.com/martinvonz/jj/releases/download/v${JJ_VERSION}/jj-v${JJ_VERSION}-${JJ_ARCH}.tar.gz" | tar xz -C /tmp
  sudo mv /tmp/jj /usr/local/bin/
  jj version || echo "Note: jj installation may have failed, continuing..."
fi

# Claude Code CLI
echo ">>> Installing Claude Code CLI..."
npm install -g @anthropic-ai/claude-code

# Codex CLI (OpenAI)
echo ">>> Installing Codex CLI..."
npm install -g @openai/codex || echo "Note: Codex CLI installation failed, continuing..."

# Playwright + Chromium for browser automation
echo ">>> Installing Playwright + Chromium..."
npm install -g playwright
npx playwright install --with-deps chromium

# Create Ralph directories
echo ">>> Setting up Ralph directories..."
mkdir -p ~/ralph/state
mkdir -p ~/work

# Copy ralph-loop.sh to ~/ralph/
# This will be done by create-ralph.sh, but create a placeholder
cat > ~/ralph/loop.sh << 'LOOP_EOF'
#!/usr/bin/env bash
# Placeholder - real script should be copied from host
echo "Error: ralph-loop.sh not installed. Copy from host."
exit 1
LOOP_EOF
chmod +x ~/ralph/loop.sh

# Configure Codex for autonomous mode
echo ">>> Configuring Codex for autonomous mode..."
mkdir -p ~/.codex
cat > ~/.codex/config.toml << 'EOF'
approval_policy = "never"
sandbox_mode = "danger-full-access"
EOF

# Git configuration defaults (user identity should be copied from host)
echo ">>> Setting up git configuration..."
git config --global init.defaultBranch main
git config --global pull.rebase true
git config --global push.autoSetupRemote true

# SSH configuration for GitHub
echo ">>> Setting up SSH configuration..."
mkdir -p ~/.ssh
chmod 700 ~/.ssh

cat > ~/.ssh/config << 'EOF'
Host github.com
    HostName github.com
    User git
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
    AddKeysToAgent yes

Host github.com-rsa
    HostName github.com
    User git
    IdentityFile ~/.ssh/id_rsa
    IdentitiesOnly yes
    AddKeysToAgent yes
EOF
chmod 600 ~/.ssh/config

# Pre-populate GitHub's SSH host keys to avoid prompts
ssh-keyscan -t ed25519,rsa github.com >> ~/.ssh/known_hosts 2>/dev/null || true
chmod 600 ~/.ssh/known_hosts

# Add Ralph helpers to bashrc
echo ">>> Adding Ralph helpers to .bashrc..."
cat >> ~/.bashrc << 'BASHRC_EOF'

# ===========================================
# Ralph Agent Configuration
# ===========================================

# Host telemetry endpoints
export HOST_ADDR="${HOST_ADDR:-host.lima.internal}"
export OTEL_EXPORTER_OTLP_ENDPOINT="http://${HOST_ADDR}:4317"
export LOKI_URL="http://${HOST_ADDR}:3100"

# Ralph state
export RALPH_STATE_DIR="${RALPH_STATE_DIR:-./state}"

# Start Ralph loop
ralph() {
  ~/ralph/loop.sh "${1:-./PROMPT.md}" "${2:-./state}"
}

# Start Ralph in tmux session
ralph-tmux() {
  local session="${1:-ralph}"
  local prompt="${2:-./PROMPT.md}"
  tmux new-session -d -s "$session" "ralph '$prompt'; exec bash"
  echo "Started Ralph in tmux session: $session"
  echo "Attach with: tmux attach -t $session"
}

# Quick status check
ralph-status() {
  local state_dir="${RALPH_STATE_DIR:-./state}"
  echo "Iteration: $(cat "$state_dir/iteration" 2>/dev/null || echo 'N/A')"
  echo "Status:    $(cat "$state_dir/status" 2>/dev/null || echo 'N/A')"
}
BASHRC_EOF

# Verify installations
echo ""
echo "=== Verifying installations ==="
echo "Node.js: $(node --version 2>/dev/null || echo 'NOT INSTALLED')"
echo "npm:     $(npm --version 2>/dev/null || echo 'NOT INSTALLED')"
echo "Claude:  $(claude --version 2>/dev/null || echo 'NOT INSTALLED')"
echo "gh:      $(gh --version 2>/dev/null | head -1 || echo 'NOT INSTALLED')"
echo "jj:      $(jj version 2>/dev/null || echo 'NOT INSTALLED')"
echo "Docker:  $(docker --version 2>/dev/null || echo 'NOT INSTALLED')"
echo ""

# Check for auth and credentials
echo "=== Checking credentials ==="
if [[ -d ~/.claude ]]; then
  echo "Claude auth:   Found (~/.claude exists)"
else
  echo "Claude auth:   NOT FOUND - copy ~/.claude from host"
fi

if [[ -d ~/.codex ]]; then
  echo "Codex auth:    Found (~/.codex exists)"
else
  echo "Codex auth:    Config created (API key may be needed)"
fi

GIT_NAME=$(git config --global user.name 2>/dev/null || echo "")
GIT_EMAIL=$(git config --global user.email 2>/dev/null || echo "")
if [[ -n "$GIT_NAME" && -n "$GIT_EMAIL" ]]; then
  echo "Git identity:  $GIT_NAME <$GIT_EMAIL>"
else
  echo "Git identity:  NOT CONFIGURED - copy ~/.gitconfig from host or run:"
  echo "               git config --global user.name 'Your Name'"
  echo "               git config --global user.email 'your@email.com'"
fi

if gh auth status &>/dev/null; then
  echo "GitHub CLI:    Authenticated"
else
  echo "GitHub CLI:    NOT AUTHENTICATED - copy ~/.config/gh from host or run: gh auth login"
fi

if [[ -f ~/.ssh/id_ed25519 || -f ~/.ssh/id_rsa ]]; then
  echo "SSH keys:      Found"
else
  echo "SSH keys:      NOT FOUND - copy ~/.ssh from host for GitHub SSH access"
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Credentials should have been copied by create-ralph.sh."
echo "If any are missing above, re-run create-ralph.sh or copy manually."
echo ""
echo "Next steps:"
echo "  1. Verify all credentials show as configured above"
echo "  2. Snapshot this VM as a template for fast cloning"
echo "  3. Log out and back in for group changes to take effect"
echo ""
