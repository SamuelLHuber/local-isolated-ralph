# TODO: Local Isolated Ralph

## High Priority (Before Team Use)

- [ ] **Test scripts on real VMs**
  - [ ] Test `create-ralph.sh` on macOS with Lima
  - [ ] Test `create-ralph.sh` on Linux with libvirt
  - [ ] Test `setup-base-vm.sh` (verification script) inside a VM
  - [ ] Test `ralph-fleet.sh` with multiple VMs
  - [ ] Test `ralph-multi.sh` (multiple Ralphs per VM)

- [ ] **Claude authentication flow**
  - [ ] Document how to persist auth across VM snapshots
  - [ ] Test that `~/.claude` or equivalent persists correctly
  - [ ] Add auth check to `setup-base-vm.sh`

- [x] **Git credentials in VMs**
  - [x] Add git config to `setup-base-vm.sh`
  - [x] Copy ~/.gitconfig, ~/.ssh, ~/.config/gh from host in `create-ralph.sh`
  - [ ] Test PR creation from inside VM

- [x] **Install jj (Jujutsu) in base VM**
  - [x] Add jj install to `setup-base-vm.sh` (supports x86_64 + aarch64)
  - [x] Add jj to Nix module (uses nixpkgs-unstable)
  - [ ] Test shared spec workflow with jj

- [x] **Make sure NixOS is used everywhere**
  - [x] All scripts use NixOS images built from flake.nix
  - [x] create-ralph.sh builds and uses NixOS QCOW2 images
  - [x] setup-base-vm.sh converted to verification-only script
  - [x] All tools installed via Nix module (modules/ralph.nix)
  - [x] macOS uses Lima (not Colima) with NixOS images
  - [x] Linux uses libvirt with NixOS images
  - [x] Documentation updated (SETUP-MACOS.md, SETUP-LINUX.md)

## Medium Priority (Polish)

- [ ] **Orchestrator script**
  - [ ] Script to parse spec → create jj changes → assign to Ralphs
  - [ ] Script to watch for `DONE` status and notify human
  - [ ] Script to collect all PR links when fleet completes

- [ ] **Improve prompt templates**
  - [ ] Add more examples
  - [ ] Add template variables substitution script
  - [ ] Test prompts produce expected JSON output

- [ ] **Message queue for agent coordination**
  - [ ] Implement shared filesystem message passing
  - [ ] Test implementer ↔ reviewer flow
  - [ ] Add watcher script for human notifications

- [ ] **Telemetry integration**
  - [ ] Add log shipping from Ralph loop to Loki
  - [ ] Create Grafana dashboard for Ralph status
  - [ ] Add iteration count / status metrics

## Low Priority (Nice to Have)

- [ ] **VM template cloning**
  - [ ] Document Lima snapshot → clone workflow
  - [ ] Document libvirt virt-clone workflow
  - [ ] Measure time savings vs fresh VM creation

- [ ] **Resource monitoring**
  - [ ] Add host resource check before creating VMs
  - [ ] Warn if insufficient RAM/disk
  - [ ] Auto-suggest VM sizing based on available resources

- [ ] **Web UI for fleet status**
  - [ ] Simple status page showing all Ralphs
  - [ ] Links to tmux attach commands
  - [ ] PR links when complete

- [ ] **CI/CD integration**
  - [ ] Document running Ralphs in CI
  - [ ] GitHub Actions example
  - [ ] Self-hosted runner with VM support

## Completed

- [x] VM creation scripts (macOS + Linux)
- [x] Multi-VM fleet management
- [x] Multi-Ralph per VM support
- [x] Telemetry stack (Grafana/Prometheus/Loki/Tempo)
- [x] Networking documentation (VM → Host)
- [x] Simplified git workflow (branches + jj, removed worktrees)
- [x] Jujutsu (jj) workflow documentation
- [x] Shared spec / swarm workflow
- [x] Implementer + Reviewer agent coordination
- [x] Prompt templates (implementer, reviewer, task)
- [x] Cleanup scripts
- [x] tmux-based visibility
- [x] NixOS-based VM images (declarative, reproducible)
- [x] All scripts use Nix (no imperative apt-get/nvm setup)
- [x] Fix playwright-browsers x86_64-only issue in ralph.nix
- [x] Document Linux builder requirement for macOS (SETUP-MACOS.md)
- [x] Copy verification script to VM (setup-base-vm.sh → ~/ralph/verify.sh)

## Known Issues

- macOS requires a Linux builder to build NixOS images (see SETUP-MACOS.md Section 2)
- Scripts not yet tested on real VMs (blocked by Linux builder setup on macOS)
- `host.lima.internal` vs `192.168.122.1` (libvirt) - scripts handle this per-platform

## Questions to Answer

- Should we support OrbStack as alternative to Lima on macOS?
    - I don't have a strong opinion on that. let's leave it out, but we can support it later if we want.
- Do we need Windows/WSL2 support?
  - NO, anyone using Windows should immediatly speak to their manager.
- Should reviewer agent auto-merge approved PRs or always wait for human?
    - always wait for human. if everything is fine. Ping human. if not launch implementation agent.
- How to handle API rate limits with large fleets?
    - we have per unit credentials, we copy our local subscriptions.
