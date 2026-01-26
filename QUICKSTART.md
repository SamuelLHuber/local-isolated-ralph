# Quickstart: Your First Ralph Agent

This guide walks you through setting up and running your first autonomous coding agent in about 15 minutes.

## Prerequisites Checklist

Before starting, ensure you have:

- [ ] **macOS 13+** (Ventura) or **Linux** with KVM support
- [ ] **Docker** installed and running
- [ ] **SSH key** generated (`ls ~/.ssh/id_*.pub`)
- [ ] **Claude subscription** with Claude Code CLI authenticated (`claude auth login` on host)

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

## Step 1: Start Telemetry (Optional but Recommended)

The telemetry stack lets you monitor your agent's progress in Grafana.

```bash
cd telemetry
docker compose up -d

# Verify it's running
curl http://localhost:3000/api/health  # Grafana
```

Open http://localhost:3000 (login: admin/admin) to see dashboards.

---

## Step 2: Authenticate Claude on Your Host

If you haven't already, authenticate Claude Code on your host machine:

```bash
claude auth login
```

This creates `~/.claude` which will be copied to your VMs.

---

## Step 3: Create Your First Ralph VM

```bash
cd /path/to/local-isolated-ralph

# Create a VM (this takes ~1-2 minutes)
./scripts/create-ralph.sh ralph-1

# The script will:
# - Create a VM with 4 CPU, 6GB RAM, 30GB disk
# - Copy your ~/.claude auth folder to the VM
# - Copy ralph-loop.sh to the VM
```

---

## Step 4: Set Up the VM

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

Exit the VM when done: `exit`

---

## Step 5: Write Your First Spec

Create a task directory with a prompt file:

```bash
mkdir -p ~/tasks/my-first-task

cat > ~/tasks/my-first-task/PROMPT.md << 'EOF'
# Task: Create a Hello World CLI

## Specification

Create a simple Node.js CLI tool that:
1. Accepts a `--name` argument
2. Prints "Hello, <name>!" to stdout
3. Defaults to "Hello, World!" if no name provided

## Repository

Clone: https://github.com/YOUR-USERNAME/hello-cli.git
Branch: feat/hello-world

## Instructions

1. Clone the repository
2. Create the feature branch
3. Implement the CLI tool in `src/index.js`
4. Add a `package.json` with a `bin` entry
5. Test it works: `node src/index.js --name Ralph`
6. Commit your changes
7. Push and create a PR

## On completion, output:

```json
{"status": "DONE", "summary": "Created hello CLI with --name flag", "pr": "feat/hello-world"}
```
EOF
```

---

## Step 6: Run Ralph!

**Option A: Run directly in VM**

SSH into the VM and run:

```bash
# macOS
colima ssh -p ralph-1

# Inside VM:
cd ~/work
cp /path/to/tasks/my-first-task/PROMPT.md .
ralph PROMPT.md
```

**Option B: Use the dispatch script (runs from host)**

```bash
# Basic usage (100 max iterations by default)
./scripts/dispatch.sh ralph-1 ~/tasks/my-first-task/PROMPT.md

# Sync a local project directory to the VM
./scripts/dispatch.sh ralph-1 ~/tasks/my-first-task/PROMPT.md ~/projects/my-app

# Limit iterations (stops after 20 loops or DONE/BLOCKED)
./scripts/dispatch.sh ralph-1 ~/tasks/my-first-task/PROMPT.md ~/projects/my-app 20

# Or use environment variable
MAX_ITERATIONS=10 ./scripts/dispatch.sh ralph-1 ~/tasks/my-first-task/PROMPT.md
```

---

## Step 7: Watch and Wait

The agent will:
1. Read the prompt
2. Clone the repo
3. Implement the feature
4. Create commits
5. Push and create a PR
6. Output `{"status": "DONE", ...}` when finished

**Monitor progress:**

- Watch the terminal output directly
- Or check Grafana at http://localhost:3000 for logs
- Check iteration status: `cat ~/work/state/status`

**If the agent gets blocked:**

It will output `{"status": "BLOCKED", "question": "..."}`. Update the PROMPT.md with clarification and the loop will continue.

---

## Step 8: Cleanup

When done, you can stop or delete the VM:

**macOS:**
```bash
colima stop -p ralph-1     # Stop (preserves state)
colima delete -p ralph-1   # Delete completely
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
- The agent stops on DONE, BLOCKED, or NEEDS_INPUT
- Set `MAX_ITERATIONS=10` to limit loops during testing

### Can't reach telemetry from VM

**macOS**: Use `host.lima.internal`
**Linux**: Use `192.168.122.1` (libvirt default gateway)

Test from inside VM:
```bash
curl http://host.lima.internal:3000/api/health   # macOS
curl http://192.168.122.1:3000/api/health        # Linux
```
