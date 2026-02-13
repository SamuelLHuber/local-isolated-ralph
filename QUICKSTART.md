# Quickstart: Your First Ralph Agent

This guide walks you through setting up and running your first autonomous coding agent in about 15 minutes.

## Prerequisites Checklist

Before starting, ensure you have:

- [ ] **macOS 13+** (Ventura) or **Linux** with KVM support
- [ ] **Docker** installed and running
- [ ] **SSH key** generated (`ls ~/.ssh/id_*.pub`)
- [ ] **pi auth** on host (`pi` then `/login`) — default agent
- [ ] **Codex auth** if using Codex (`codex login`)
- [ ] **Claude auth** if using Claude (`claude auth login`)

**macOS specific:**
```bash
brew install colima docker
colima version  # Should be 0.6.0+
```

**Linux specific:**
```bash
sudo apt install qemu-kvm libvirt-daemon-system virtinst cloud-image-utils
virsh list --all  # Should work without errors
```

---

## Step 1: Start LAOS (Optional but Recommended)

The LAOS stack lets you monitor your agent's progress in Grafana, plus Sentry/PostHog.

```bash
# Source of truth: https://github.com/dtechvision/laos
mkdir -p ~/git
if [[ -d ~/git/laos/.git ]]; then
  (cd ~/git/laos && git pull)
else
  git clone https://github.com/dtechvision/laos.git ~/git/laos
fi
cd ~/git/laos
docker compose up -d

# Verify it's running
curl http://localhost:3010/api/health  # Grafana
```

Open http://localhost:3010 (login: admin/admin) to see dashboards.

Optional: create a shared env file so LAOS endpoints get copied into VMs:

```bash
cd /path/to/local-isolated-ralph
./scripts/create-ralph-env.sh
# Edit ~/.config/ralph/ralph.env and set:
# macOS (Lima):  LAOS_HOST=host.lima.internal
# Linux (libvirt): LAOS_HOST=192.168.122.1
```

---

## Step 2: Authenticate Agents on Your Host

If you haven't already, authenticate pi on your host machine:

```bash
pi
/login
```

This creates `~/.pi/agent/auth.json` which will be copied to your VMs.

Optional (only if using Codex):

```bash
codex login
```

Optional (only if using Claude):

```bash
claude auth login
```

---

## Step 3: Set Up GitHub Token

Create a token at https://github.com/settings/tokens/new (scopes: `repo`, `workflow`) and add to `~/.config/ralph/ralph.env`:

```bash
./scripts/create-ralph-env.sh
# Edit the file and add: export GITHUB_TOKEN="ghp_your_token"
```

---

## Step 4: Create Your First Ralph VM

```bash
cd /path/to/local-isolated-ralph

# Create a VM (this takes ~1-2 minutes)
./scripts/create-ralph.sh ralph-1

# The script will:
# - Create a VM with 4 CPU, 6GB RAM, 30GB disk
# - Copy your ~/.claude auth folder to the VM
# - Install Smithers (required)
# - Copy ~/.config/ralph/ralph.env (with GITHUB_TOKEN)
```

---

## Step 5: Set Up the VM

SSH into the VM and run the setup script:

**macOS:**
```bash
colima ssh -p ralph-1

# Inside VM:
curl -fsSL https://raw.githubusercontent.com/your-org/local-isolated-ralph/main/scripts/setup-base-vm.sh | bash
# Or if you have the repo mounted:
# bash /path/to/scripts/setup-base-vm.sh
```

**Linux:**
```bash
# Get VM IP
VM_IP=$(virsh domifaddr ralph-1 | grep ipv4 | awk '{print $4}' | cut -d/ -f1)
ssh dev@$VM_IP

# Inside VM:
curl -fsSL https://raw.githubusercontent.com/your-org/local-isolated-ralph/main/scripts/setup-base-vm.sh | bash
```

The setup script installs Node.js, Claude CLI, GitHub CLI, Playwright, and more.

**Configure git identity:**
```bash
git config --global user.name "Your Name"
git config --global user.email "your@email.com"
```

**Verify Claude auth works:**
```bash
claude --version
# Should show version without auth errors
```

**Install Smithers (required):**
```bash
bun add -g github:evmts/smithers#ea5ece3b156ebd32990ec9c528f9435c601a0403
```

**Verify JJ is available (required):**
```bash
jj --version
```

Exit the VM when done: `exit`

If you need to re-sync credentials later:

```bash
./scripts/sync-credentials.sh ralph-1
# Or via CLI
fabrik credentials sync --vm ralph-1
```

To store a Claude Code token for syncing:

```bash
./scripts/create-ralph-env.sh
# Edit ~/.config/ralph/ralph.env and set:
# export CLAUDE_CODE_OAUTH_TOKEN="..."
```

Note: Claude CLI auth is stored in `~/.claude.json` on the host. Make sure it exists (or set `ANTHROPIC_API_KEY` in `ralph.env`) before syncing.

---

## Step 6: Write Your First Spec

Create a JSON spec and TODO (Fabrik will minify on dispatch):

```bash
# Use templates as a starting point
cp specs/templates/spec.json specs/001-hello-world.json
cp specs/templates/todo.json specs/001-hello-world.todo.json

# Edit both files, then validate
bun run scripts/validate-specs.ts
```

---

## Step 7: Run Smithers

**Use the Fabrik CLI (runs from host)**

```bash
# Smithers mode (spec/todo JSON; minified on dispatch)
./dist/fabrik run --spec specs/001-hello-world.json --vm ralph-1

# Sync a local project directory to the VM
./dist/fabrik run --spec specs/001-hello-world.json --vm ralph-1 --project ~/projects/my-app

# Limit iterations (stops after 20 Smithers iterations)
./dist/fabrik run --spec specs/001-hello-world.json --vm ralph-1 --project ~/projects/my-app --iterations 20

# Or use environment variable
MAX_ITERATIONS=10 ./dist/fabrik run --spec specs/001-hello-world.json --vm ralph-1
```

**Smithers loop at a glance:**
```
spec.json + todo.json (minified on dispatch) → smithers workflow → task_report rows (per task)
```

---

## Step 8: Watch and Wait

The workflow will:
1. Read `spec.json` + `todo.json` (minified on dispatch)
2. Implement tasks in order
3. Write `task_report` rows in the Smithers SQLite db
4. Run an agent reviewer
5. Write `review_report`, `review_summary`, and `human_gate` rows in the Smithers db
6. Stop for human review

**Monitor progress:**

- Watch the terminal output directly
- Or check Grafana at http://localhost:3010 for logs
- Check iteration status: `cat ~/work/state/status`
- Or use the CLI watcher: `fabrik runs watch --vm ralph-1`
- Inspect failures with `fabrik runs show --id <run-id>` (prints `failure_reason` when available)

**Human review gate:**

After the reviewer runs, a `human_gate` row is written in the Smithers db with `status: "blocked"`.
Human approves, then starts the next spec run.

**Custom prompts:**

```bash
./dist/fabrik run --spec specs/001-hello-world.json --vm ralph-1 \
  --prompt ./prompts/PROMPT-implementer.md \
  --review-prompt ./prompts/PROMPT-reviewer.md
```

Record feedback:

```bash
./scripts/record-human-feedback.sh --vm ralph-1 --spec specs/001-hello-world.json \
  --decision approve --notes "Matches spec."
```

### Desktop notifications

Install a notifier to get popups from `fabrik runs watch`:

- macOS: `brew install terminal-notifier`
- Linux: `sudo apt install libnotify-bin` (provides `notify-send`)

**Immutable runs:**

Each run gets a new workdir and is tracked in `~/.cache/ralph/ralph.db`.

---

## Step 9: Cleanup

When done, you can stop or delete the VM:

**macOS:**
```bash
colima stop -p ralph-1     # Stop (preserves state)
colima delete -p ralph-1   # Delete completely
```

Cleanup old workdirs:

```bash
./scripts/cleanup-workdirs.sh ralph-1 --keep 5
```

**Linux:**
```bash
virsh shutdown ralph-1                              # Stop
virsh destroy ralph-1; virsh undefine ralph-1 --remove-all-storage  # Delete
```

---

## Next Steps

- **Run multiple Ralphs**: See [WORKFLOW.md](./WORKFLOW.md) for fleet patterns
- **Create a VM template**: Set up once, snapshot, clone quickly
- **Use Jujutsu (jj)**: For advanced parallel work on the same repo
- **Set up Implementer + Reviewer**: Agents review each other's code

---

## Quick Reference

| Task | macOS | Linux |
|------|-------|-------|
| Create VM | `./scripts/create-ralph.sh ralph-1` | Same |
| SSH into VM | `colima ssh -p ralph-1` | `ssh dev@<IP>` |
| Get VM IP | N/A (use colima ssh) | `virsh domifaddr ralph-1` |
| Stop VM | `colima stop -p ralph-1` | `virsh shutdown ralph-1` |
| Delete VM | `colima delete -p ralph-1` | `virsh undefine ralph-1 --remove-all-storage` |
| List VMs | `colima list` | `virsh list --all` |

---

## Troubleshooting

### VM creation fails

**macOS**: Try falling back to QEMU:
```bash
colima start -p ralph-1 --vm-type qemu --cpu 4 --memory 6
```

**Linux**: Check KVM is enabled:
```bash
lscpu | grep Virtualization  # Should show VT-x or AMD-V
```

### Claude auth not working in VM

Re-copy the auth folder:
```bash
# macOS
tar -C ~ -cf - .claude | colima ssh -p ralph-1 -- tar -C ~ -xf -

# Linux
scp -r ~/.claude dev@<VM_IP>:~/
```

### Agent loops forever

- Check `~/work/state/status` for current state
- The workflow stops when all tasks are done or when a task is blocked/failed
- Set `MAX_ITERATIONS=10` to limit loops during testing

### Can't reach LAOS from VM

**macOS**: Use `host.lima.internal`
**Linux**: Use `192.168.122.1` (libvirt default gateway)

Test from inside VM:
```bash
curl http://host.lima.internal:3010/api/health   # macOS
curl http://192.168.122.1:3010/api/health        # Linux
```
