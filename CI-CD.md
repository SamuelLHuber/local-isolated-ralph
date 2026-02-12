# CI/CD Integration (Ralph + Fabrik)

This guide shows how to run Ralph/Fabrik workflows from CI with a self-hosted GitHub Actions runner.
Ralph requires VM access, so hosted runners are **not** supported.

## Prerequisites (Runner Host)

- macOS (Lima) or Linux (libvirt) host with VMs pre-created.
- `bun`, `limactl` (macOS) or `virsh` (Linux) installed.
- Smithers installed inside the VM base image.
- `GITHUB_TOKEN` and any AI credentials stored in `~/.config/ralph/ralph.env`.

Recommended: pre-create a template VM and clone for fast provisioning.

## Runner Setup

1. Install the GitHub Actions self-hosted runner on the host:
   - https://docs.github.com/en/actions/hosting-your-own-runners/adding-self-hosted-runners
2. Ensure the runner user can access VM tools:
   - macOS: `limactl list` works for the runner user.
   - Linux: user is in `libvirt` and `kvm` groups.
3. Verify the CLI:

```bash
bun --version
limactl --version   # macOS only
virsh --version     # Linux only
```

## Minimal Workflow (Build + Spec Validation)

Create `.github/workflows/ralph.yml`:

```yaml
name: Ralph CI

on:
  workflow_dispatch:
  push:
    branches: [ main ]

jobs:
  build-and-validate:
    runs-on: self-hosted
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
        with:
          bun-version: latest
      - name: Install
        run: bun install
      - name: Build fabrik
        run: bun run build
      - name: Validate specs
        run: ./dist/fabrik spec validate
```

## Example: Dispatch a VM Run

```yaml
  run-ralph:
    runs-on: self-hosted
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
        with:
          bun-version: latest
      - name: Install
        run: bun install
      - name: Build fabrik
        run: bun run build
      - name: Dispatch run
        env:
          RALPH_AGENT: codex
          LOCAL_RALPH_HOME: ${{ github.workspace }}
        run: |
          ./dist/fabrik run --spec specs/000-base.min.json --vm ralph-1 --iterations 20
```

## Notes

- For repo checkout inside VMs, prefer `--repo`/`--ref` and include `GITHUB_TOKEN` in `ralph.env`.
- Use `fabrik run --follow` if you want CI logs to stream Smithers output.
- Ensure VMs are started before the workflow runs (`limactl start ralph-1` / `virsh start ralph-1`).
