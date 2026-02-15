# Fabrik Learnings - Handoff Document

**Date**: 2026-02-15  
**Status**: ✅ Ready for production use  
**Last Updated**: After sync fix and credential validation

---

## Quick Start for New Developer

### 1. Build the CLI

```bash
cd ~/git/local-isolated-ralph
bun install
bun run build

# Verify
./dist/fabrik --version
```

### 2. Validate Your Environment

```bash
# Check ralph.env is properly configured
./dist/fabrik credentials validate

# Create ralph.env template (if missing)
./dist/fabrik credentials init

# Test API keys work in VM
./dist/fabrik credentials test --vm ralph-1

# Sync to VM
./dist/fabrik credentials sync --vm ralph-1
```

### 3. Run a Spec

```bash
# Default: sequential workflow (small-to-medium specs)
./dist/fabrik run \
  --spec specs/feature.md \
  --project ~/my-app \
  --vm ralph-1 \
  --follow

# Dynamic: runtime discovery (large specs >20 tasks)
./dist/fabrik run \
  --spec specs/big-prd.md \
  --project ~/my-app \
  --vm ralph-1 \
  --dynamic \
  --follow
```

---

## Architecture Overview

### Workflow Selection

| Mode | File | Use Case | Command |
|------|------|----------|---------|
| **Sequential** (default) | `workflow.tsx` | 5-20 tasks, clear milestones | `fabrik run --spec ...` |
| **Dynamic** | `workflow-dynamic.tsx` | >20 tasks, evolving scope | `fabrik run --spec ... --dynamic` |
| **Custom** | Your file | Special requirements | `fabrik run --workflow ./custom.tsx` |

### Three-Phase Execution (Both Workflows)

```
┌─────────────────────────────────────────────────────────────────┐
│ Phase 1: Task Implementation (Ralph Loop)                       │
│ Implement → Validate → LightReview → ReviewFix (if issues)      │
│     ↑__________________________________________↓                │
│ Loop until CODE-QUALITY + MAINTAINABILITY approve                │
└─────────────────────────────────────────────────────────────────┘
                              ↓ All tasks done
┌─────────────────────────────────────────────────────────────────┐
│ Phase 2: Full Review (Ralph Loop)                                │
│ All 8 Reviewers (parallel) → ReviewFix → Re-validate             │
│     ↑______________________________________________↓             │
│ Loop until ALL reviewers approve, then re-run to validate        │
└─────────────────────────────────────────────────────────────────┘
                              ↓ All reviews passed
┌─────────────────────────────────────────────────────────────────┐
│ Phase 3: Human Gate (needsApproval)                              │
│ Human reviews → Approve (DONE) or Reject → Feedback → Phase 1    │
└─────────────────────────────────────────────────────────────────┘
```

### Reviewers

**Per-Task (Light Review):**
- `CODE-QUALITY.md`
- `MAINTAINABILITY.md`

**Full Review (All 8 in Parallel):**
- `CODE-QUALITY.md`
- `MAINTAINABILITY.md`
- `SECURITY.md`
- `SIMPLICITY.md`
- `TIGERSTYLE.md`

---

## VM Management

### List VMs
```bash
./dist/fabrik vm list
```

### Cleanup VMs
```bash
# Delete specific VMs
./dist/fabrik vm cleanup --vms ralph-1,ralph-2 --force

# Delete all Ralph VMs
./dist/fabrik vm cleanup --all --force
```

### Credential Management
```bash
# Create ralph.env template
./dist/fabrik credentials init

# Validate ralph.env format
./dist/fabrik credentials validate

# Test API keys in VM
./dist/fabrik credentials test --vm ralph-1

# Sync credentials to VM
./dist/fabrik credentials sync --vm ralph-1
```
