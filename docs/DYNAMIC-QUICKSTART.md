# Dynamic Compound Engineering - Quick Start

## Overview

The dynamic workflow combines:
- **Markdown specs** - Write specs in natural language
- **Dynamic discovery** - AI generates tickets at runtime based on spec + codebase
- **Adaptive tiers** - T1-T4 classification with appropriate guarantees
- **Learning system** - Captures execution data to optimize future runs

## Usage

### 1. Write a Markdown Spec

Create `specs/feature.md`:

```markdown
# Specification: Feature Name

## Overview
Brief description of what this feature does.

## Goals
- Goal 1: Implement X
- Goal 2: Support Y
- Goal 3: Ensure Z

## Non-Goals
- Out of scope for this phase
- Deferred to future work

## Requirements
- API endpoint for creating X
- Validation for input Y
- Observability with logging

## Acceptance Criteria
- User can complete the flow end-to-end
- Tests pass with 85% coverage
- Security review approved
```

### 2. Run with Dynamic Discovery

```bash
# Basic dynamic run (no todo.json needed!)
./dist/fabrik run \
  --spec specs/feature.md \
  --vm ralph-1 \
  --dynamic \
  --follow

# With learning capture for optimization
./dist/fabrik run \
  --spec specs/feature.md \
  --vm ralph-1 \
  --dynamic \
  --learn \
  --follow

# With project sync
./dist/fabrik run \
  --spec specs/feature.md \
  --project /path/to/repo \
  --vm ralph-1 \
  --dynamic \
  --learn
```

### 3. View Learned Patterns

After a few runs, the system learns what works:

```bash
# Show patterns learned from execution
./dist/fabrik patterns show

# Example output:
# Task Type: api-endpoint
#   Tier: T2 (confidence: 80%, n=8)
#   Reviews: [security, code-quality]
#   Model: standard
#   Gates: [lint, typecheck, build, test]
#   Avg Cost: $2.50, Avg Hours: 1.5
#
# Task Type: ui-styling
#   Tier: T4 (confidence: 60%, n=3)
#   Reviews: []
#   Model: cheap
#   Gates: [lint, typecheck]
#   Avg Cost: $0.40, Avg Hours: 0.5
```

### 4. Reset Patterns (if needed)

```bash
# Clear all learned patterns
./dist/fabrik patterns reset
```

## How It Works

### 1. Discovery Phase

The **Discover** agent reads your markdown spec and:
- Analyzes the codebase to see what's already implemented
- Classifies work into T1-T4 tiers
- Generates 3-5 tickets with appropriate:
  - **Layers** (L1-L6 guarantee layers)
  - **Reviews** (adaptive, not always 8)
  - **Gates** (deterministic checks)
  - **Model** (cheap/standard/powerful based on tier)

### 2. Adaptive Pipeline Per Ticket

```
Ticket → Implement → Deterministic Gates → Conditional LLM Review → Report
```

**T1 (Critical)** - Money/Auth/Irreversible:
- All 6 layers (L1-L5 + Simulation)
- 4 reviewers (security, correctness, nasa-10, test-coverage)
- Powerful model (expensive, thorough)
- Gates: lint, typecheck, build, test, coverage

**T2 (Important)** - User Data/Business Logic:
- Layers L1-L5
- 3 reviewers (security, code-quality, test-coverage)
- Standard model
- Gates: lint, typecheck, build, test

**T3 (Standard)** - Features/UI:
- Layers L1-L4
- 1 reviewer (conditional - only if gates fail)
- Standard model
- Gates: lint, typecheck, build, test

**T4 (Low)** - Analytics/Logging:
- Layers L1, L4
- No LLM review (deterministic gates only)
- Cheap model
- Gates: lint, typecheck, build

### 3. Learning Capture

With `--learn`, after each ticket:
- Records prediction vs actual performance
- Extracts patterns (task type → optimal tier/reviews/model)
- Saves to `.fabrik/patterns.json`

### 4. Re-Render Loop

When all tickets complete:
1. If `batchComplete: false` → Discover runs again for next batch
2. If `batchComplete: true` → Workflow completes

## File Structure

```
repo/
├── specs/
│   └── feature.md              # Your markdown spec
├── .fabrik/                    # Learning data (auto-created)
│   ├── patterns.json           # Learned optimization patterns
│   └── learnings.jsonl         # Raw execution data
└── .smithers/
    └── feature.dynamic.db      # Smithers orchestration state
```

## Compound Engineering Principles

The 6-layer guarantee system:

| Layer | Guarantee | Implementation |
|-------|-----------|----------------|
| L1 | Type Safety | Branded types, phantom types |
| L2 | Runtime | Effect.assert pre/postconditions |
| L3 | Persistence | DB constraints, UNIQUE/CHECK |
| L4 | Tests | @property tests, coverage thresholds |
| L5 | Monitoring | Production TODOs, alerts |
| L6 | Simulation | 24/7 seed-based testing (T1 only) |

## Cost Optimization

Dynamic mode automatically optimizes costs:

| Tier | Model | Reviews | Est. Cost/Ticket |
|------|-------|---------|-----------------|
| T1 | Powerful | 4 | ~$5.00 |
| T2 | Standard | 3 | ~$2.50 |
| T3 | Standard | 0-1 | ~$0.80 |
| T4 | Cheap | 0 | ~$0.30 |

**Total savings vs. 8-reviewer pipeline:** 60-80% for T3/T4 work

## Comparison: Traditional vs Dynamic

| Aspect | Traditional | Dynamic |
|--------|-------------|---------|
| Spec format | JSON required | Markdown supported |
| Todo | Hardcoded upfront | Generated at runtime |
| Reviews | Fixed 8 reviewers | Adaptive (1-4) |
| Model | One size fits all | Tier-based selection |
| Gates | After LLM review | Before (fast feedback) |
| Learning | None | Continuous optimization |
| Best for | < 20 tasks, clear scope | > 20 tasks, evolving scope |

## Migration from JSON Specs

Existing JSON specs work unchanged. To migrate to markdown:

```bash
# Convert JSON to markdown (manual)
# 1. Copy spec.json content to spec.md
# 2. Reformat as markdown sections
# 3. Run with --dynamic flag

# Or keep using JSON with traditional workflow:
./dist/fabrik run --spec specs/feature.json --todo specs/feature.todo.json --vm ralph-1
```

## Troubleshooting

**"No patterns learned yet"**
- Run with `--learn` flag to start capturing data
- Need 3+ runs of similar task types to extract patterns

**"Spec ID not found"**
- Add frontmatter to markdown: `---
id: my-feature
---`
- Or use filename: `spec-my-feature.md`

**Too many/few reviews**
- Patterns adapt over time. Let it learn from 5-10 runs.
- Or manually tune in `.fabrik/patterns.json`

**Discover generating wrong tickets**
- The spec markdown may need clearer goals/non-goals
- First run may be imperfect - it learns from execution
