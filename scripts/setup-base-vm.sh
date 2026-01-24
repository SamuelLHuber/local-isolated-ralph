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

# Jujutsu (jj) - optional but recommended for parallel work
echo ">>> Installing Jujutsu (jj)..."
JJ_VERSION="0.24.0"
curl -fsSL "https://github.com/martinvonz/jj/releases/download/v${JJ_VERSION}/jj-v${JJ_VERSION}-x86_64-unknown-linux-musl.tar.gz" | tar xz -C /tmp
sudo mv /tmp/jj /usr/local/bin/
jj version || echo "Note: jj installation may have failed, continuing..."

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

# Git configuration placeholder
echo ">>> Setting up git configuration..."
cat >> ~/.gitconfig << 'EOF'
[user]
	# Set your name and email here or via environment variables
	# name = Your Name
	# email = your.email@example.com
[init]
	defaultBranch = main
[pull]
	rebase = true
[push]
	autoSetupRemote = true
EOF

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

# Check for auth folders
echo "=== Checking auth folders ==="
if [[ -d ~/.claude ]]; then
  echo "Claude auth: Found (~/.claude exists)"
else
  echo "Claude auth: NOT FOUND - copy ~/.claude from host"
fi

if [[ -d ~/.codex ]]; then
  echo "Codex auth:  Found (~/.codex exists)"
else
  echo "Codex auth:  Config created (API key may be needed)"
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. Copy auth folders from host if not already done:"
echo "     scp -r ~/.claude dev@<vm-ip>:~/"
echo "     scp -r ~/.codex dev@<vm-ip>:~/"
echo ""
echo "  2. Configure git identity:"
echo "     git config --global user.name 'Your Name'"
echo "     git config --global user.email 'your@email.com'"
echo ""
echo "  3. Snapshot this VM as a template for fast cloning"
echo ""
echo "  4. Log out and back in for group changes to take effect"
echo ""
