# TODO: Local Isolated Ralph

## High Priority (Before Team Use)

- [ ] **Test scripts on real VMs**
  - [ ] Test `create-ralph.sh` on macOS with Colima
  - [ ] Test `create-ralph.sh` on Linux with libvirt
  - [ ] Test `setup-base-vm.sh` inside a VM
  - [ ] Test `ralph-fleet.sh` with multiple VMs
  - [ ] Test `ralph-multi.sh` (multiple Ralphs per VM)

- [ ] **Claude authentication flow**
  - [ ] Document how to persist auth across VM snapshots
  - [ ] Test that `~/.claude` or equivalent persists correctly
  - [ ] Add auth check to `setup-base-vm.sh`

- [ ] **Git credentials in VMs**
  - [ ] Add git config to `setup-base-vm.sh`
  - [ ] Document SSH key or token setup for GitHub
  - [ ] Test PR creation from inside VM

- [ ] **Install jj (Jujutsu) in base VM**
  - [ ] Add jj install to `setup-base-vm.sh`
  - [ ] Test shared spec workflow with jj

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
  - [ ] Document Colima snapshot → clone workflow
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

## Known Issues

- Scripts not yet tested on real VMs
- `host.lima.internal` vs `host.docker.internal` may need runtime detection
- Colima profile syntax may vary by version
- Linux `cloud-localds` package name varies by distro

## Questions to Answer

- Should we support OrbStack as alternative to Colima on macOS?
    - I don't have a strong opinion on that. let's leave it out, but we can support it later if we want.
- Do we need Windows/WSL2 support?
  - NO, anyone using Windows should immediatly speak to their manager.
- Should reviewer agent auto-merge approved PRs or always wait for human?
    - always wait for human. if everything is fine. Ping human. if not launch implementation agent.
- How to handle API rate limits with large fleets?
    - we have per unit credentials, we copy our local subscriptions.
