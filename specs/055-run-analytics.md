# Spec: Run Analytics & Feedback Loop

> Collect, analyze, and act on run data to improve specifications and success rates

**Status**: draft  
**Version**: 1.0.0  
**Last Updated**: 2026-02-16  
**Depends On**: `051-k3s-orchestrator`, `056-cost-management`  
**Provides**: Data-driven improvement of specs and run configuration

---

## Changelog

- **v1.0.0** (2026-02-16): Initial specification

---

## Identity

**What**: Analytics system that:
1. **Collects** run outcomes, resources, costs, patterns
2. **Analyzes** success/failure predictors, optimal configurations
3. **Suggests** spec improvements, model choices, resource settings
4. **Adapts** future runs based on historical data

**Why**: We're flying blind without data. 30% of runs fail due to wrong resource limits, poor model choice, or spec issues we could predict.

**Not**: 
- Real-time business intelligence dashboards (deferred)
- ML-based code generation (v2)
- External analytics SaaS (self-hosted only)

---

## Goals

1. **Track every run**: Outcome, duration, cost, resources used, errors
2. **Identify patterns**: "Specs of type X fail 40% with Sonnet, 15% with Opus"
3. **Suggest optimizations**: "Increase memory to 4Gi (75% of similar runs OOM)"
4. **Auto-adapt configs**: Pick best model/resources based on spec fingerprint
5. **Quality feedback**: Flag specs that consistently underperform for rewriting

---

## Non-Goals

- Complex ML pipelines (start with SQL aggregations)
- Real-time predictive alerts during runs
- External BI tools (Tableau, etc.)
- Automatic spec rewriting without human review

---

## Architecture

```
┌─ Run Analytics System ────────────────────────────────────────────────────┐
│                                                                           │
│  ┌─ Data Collection ─────────────────────────────────────────────────────┐ │
│  │  Sources:                                                             │ │
│  │  ├── K8s Job/Pod annotations (start, end, phase, task)                 │ │
│  │  ├── Smithers progress updates (iterations, attempts)                  │ │
│  │  ├── LLM cost annotations (tokens, model, price)                     │ │
│  │  ├── Prometheus metrics (memory, CPU usage)                             │ │
│  │  └── Loki logs (errors, completion status)                             │ │
│  │                                                                        │ │
│  │  Storage: SQLite ~/.cache/fabrik/analytics.db                         │ │
│  │  ├─ runs: Full run record (id, spec, outcome, duration, cost)         │ │
│  │  ├─ tasks: Per-task breakdown (type, model, tokens, success)        │ │
│  │  ├─ resources: Memory/CPU peaks per run                               │ │
│  │  └─ errors: Error patterns and frequencies                             │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                              │                                            │
│                              ▼                                            │
│  ┌─ Analysis Queries (scheduled or on-demand) ─────────────────────────┐ │
│  │  ├─ Model effectiveness per spec type                                │ │
│  │  ├─ Resource usage percentiles (p50, p95, p99)                       │ │
│  │  ├─ Failure patterns (OOM, timeout, error type)                      │ │
│  │  ├─ Cost efficiency (success per dollar)                            │ │
│  │  └─ Spec quality scores (success rate, iteration count)              │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                              │                                            │
│                              ▼                                            │
│  ┌─ Suggestion Engine ───────────────────────────────────────────────────┐ │
│  │  Produces:                                                            │ │
│  │  ├── Spec improvements ("Add retry clause for network calls")         │ │
│  │  ├── Model recommendations ("Use Opus for complex specs (>7 tasks)")    │ │
│  │  ├── Resource tuning ("Set memory: 4Gi based on p95 usage")           │ │
│  │  └── Risk warnings ("This spec pattern fails 60% - review needed")   │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                              │                                            │
│                              ▼                                            │
│  ┌─ Feedback Channels ───────────────────────────────────────────────────┐ │
│  │  ├── CLI: `fabrik suggest` shows recommendations                     │ │
│  │  ├── TUI: Dashboard highlights underperforming specs                 │ │
│  │  ├── GitHub PR: Auto-suggest spec updates with data backing          │ │
│  │  └── Spec metadata: `_learned` fields with optimal settings           │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## Data Schema

```sql
-- Run outcomes
CREATE TABLE runs (
  id TEXT PRIMARY KEY,                    -- ULID
  spec_id TEXT,                           -- Which spec was run
  spec_fingerprint TEXT,                  -- Hash of spec content (detect changes)
  project_id TEXT,
  
  -- Configuration used
  model TEXT,                             -- claude-3-5-sonnet, gpt-4o, etc.
  memory_limit TEXT,                      -- "4Gi"
  cpu_limit TEXT,                         -- "2"
  
  -- Outcome
  status TEXT,                            -- success, failed, cancelled, timeout
  failure_reason TEXT,                    -- oom, error, timeout, killed
  
  -- Timing
  started_at INTEGER,                     -- Unix timestamp
  completed_at INTEGER,
  duration_seconds INTEGER,
  
  -- Efficiency
  iterations INTEGER,                     -- How many loops through tasks
  attempts INTEGER,                       -- Total task attempts (incl retries)
  tasks_total INTEGER,
  tasks_completed INTEGER,
  
  -- Cost
  llm_cost_usd REAL,                      -- From annotations
  infrastructure_cost_eur REAL,             -- Estimated from duration
  
  -- Resources (from Prometheus/annotations)
  memory_peak_mb INTEGER,
  cpu_peak_mcores INTEGER,
  
  -- Quality (from LAOS lint if available)
  error_rate REAL,
  latency_p95_ms INTEGER,
  
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Per-task breakdown
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES runs(id),
  task_type TEXT,                         -- impl, review, validate, etc.
  model TEXT,
  
  -- Tokens
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  
  -- Outcome
  status TEXT,                            -- success, failed, retry
  duration_seconds INTEGER,
  error_type TEXT,                        -- compile_error, test_fail, timeout, etc.
  error_message TEXT                      -- First 500 chars
);

-- Spec quality tracking
CREATE TABLE spec_quality (
  spec_id TEXT PRIMARY KEY,
  version TEXT,
  runs_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  
  -- Aggregates (updated nightly)
  avg_duration_seconds REAL,
  avg_cost_usd REAL,
  avg_iterations REAL,
  p95_memory_mb INTEGER,
  
  -- Flags
  needs_review BOOLEAN DEFAULT 0,         -- Success rate < 70%
  last_analyzed_at INTEGER
);

-- Suggestions generated
CREATE TABLE suggestions (
  id TEXT PRIMARY KEY,
  type TEXT,                              -- resource, model, spec_rewrite, warning
  spec_id TEXT,
  confidence REAL,                          -- 0-1
  data_points INTEGER,                      -- How many runs support this
  
  current_value TEXT,                       -- e.g., "memory: 2Gi"
  suggested_value TEXT,                     -- e.g., "memory: 4Gi"
  reasoning TEXT,                           -- "75% of similar runs OOM at 2Gi"
  
  status TEXT DEFAULT 'pending',          -- pending, applied, rejected
  created_at INTEGER
);
```

---

## CLI Commands

```bash
# View suggestions for current project
fabrik suggest
# Output:
# ┌─ Suggestions (3) ─────────────────────────────────────────────────────┐
# │                                                                         │
# │  1. [HIGH] specs/api-impl.json - Increase memory to 4Gi                 │
# │     Confidence: 87% (47 similar runs, 75% OOM at 2Gi)                │
# │     [a] Apply  [v] View data  [i] Ignore                              │
# │                                                                         │
# │  2. [MED] specs/db-migration.json - Use Opus for >10 tasks            │
# │     Confidence: 72% (23 runs, Opus: 95% success, Sonnet: 68%)          │
# │                                                                         │
# │  3. [LOW] specs/fix-bug.json - Spec underperforming                   │
# │     Success rate: 45% (avg 82%) - Consider rewrite                     │
# │                                                                         │
# └─────────────────────────────────────────────────────────────────────────┘

# Query analytics
fabrik analytics runs --spec specs/api-impl.json --last-30d
fabrik analytics models --task-type impl --success-rate
fabrik analytics resources --show-p95

# Generate spec quality report
fabrik analytics report --format markdown > spec-quality-report.md

# Export data for external analysis
fabrik analytics export --start 2026-01-01 --end 2026-02-01 > analytics.csv
```

---

## Analysis Queries

### Model Effectiveness

```sql
-- Which model succeeds most for each spec type?
SELECT 
  s.spec_type,
  r.model,
  COUNT(*) as runs,
  SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) * 1.0 / COUNT(*) as success_rate,
  AVG(r.duration_seconds) as avg_duration,
  AVG(r.llm_cost_usd) as avg_cost
FROM runs r
JOIN specs s ON r.spec_id = s.id
WHERE r.started_at > strftime('%s', 'now', '-30 days')
GROUP BY s.spec_type, r.model
HAVING runs > 10
ORDER BY success_rate DESC;
```

### Resource Optimization

```sql
-- What's the optimal memory limit per spec complexity?
WITH percentiles AS (
  SELECT 
    spec_id,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY memory_peak_mb) as p95_memory,
    PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY memory_peak_mb) as p99_memory
  FROM runs
  WHERE status = 'success'
  GROUP BY spec_id
)
SELECT 
  s.id,
  s.complexity,
  p.p95_memory,
  p.p99_memory,
  CASE 
    WHEN p.p95_memory < 1024 THEN '1Gi'
    WHEN p.p95_memory < 2048 THEN '2Gi'
    WHEN p.p95_memory < 4096 THEN '4Gi'
    ELSE '8Gi'
  END as recommended_limit
FROM specs s
JOIN percentiles p ON s.id = p.spec_id
WHERE s.current_memory_limit != recommended_limit;
```

### Failure Pattern Detection

```sql
-- What error types correlate with which spec patterns?
SELECT 
  t.error_type,
  s.spec_type,
  s.task_count,
  COUNT(*) as occurrences,
  AVG(t.duration_seconds) as avg_time_to_failure
FROM tasks t
JOIN runs r ON t.run_id = r.id
JOIN specs s ON r.spec_id = s.id
WHERE t.status = 'failed'
GROUP BY t.error_type, s.spec_type, s.task_count
HAVING occurrences > 5
ORDER BY occurrences DESC;
```

---

## Suggestion Generation

```typescript
// Generate suggestions from analytics data
class SuggestionEngine {
  async generate(): Promise<Suggestion[]> {
    const suggestions: Suggestion[] = [];
    
    // 1. Resource tuning
    const resourceData = await this.db.query(`
      SELECT spec_id, current_memory, 
             PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY memory_peak) as p95,
             COUNT(CASE WHEN failure_reason = 'oom' THEN 1 END) as oom_count
      FROM runs
      GROUP BY spec_id
      HAVING oom_count > 3
    `);
    
    for (const row of resourceData) {
      if (row.p95 > parseMemory(row.current_memory) * 0.8) {
        suggestions.push({
          type: 'resource',
          specId: row.spec_id,
          confidence: Math.min(0.95, row.oom_count / 10),
          dataPoints: row.oom_count,
          current: `memory: ${row.current_memory}`,
          suggested: `memory: ${recommendMemory(row.p95)}`,
          reasoning: `${row.oom_count} OOM failures. p95 memory: ${row.p95}MB`
        });
      }
    }
    
    // 2. Model recommendations
    const modelData = await this.db.query(`
      SELECT spec_type, model, 
             AVG(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_rate,
             COUNT(*) as runs
      FROM runs
      GROUP BY spec_type, model
      HAVING runs > 10
    `);
    
    // Find specs where alternative model has significantly better success
    // ...
    
    return suggestions;
  }
}
```

---

## Spec Metadata Integration

Specs get `_learned` fields auto-populated:

```json
{
  "id": "api-implementation",
  "version": "1.0.0",
  "tasks": [...],
  "_learned": {
    "last_updated": "2026-02-16T12:00:00Z",
    "runs_count": 47,
    "success_rate": 0.89,
    "optimal_model": "claude-3-5-sonnet-20241022",
    "recommended_resources": {
      "memory": "4Gi",
      "cpu": 2
    },
    "avg_duration_minutes": 12.5,
    "avg_cost_usd": 0.45,
    "common_failures": ["test_timeout", "compile_error"],
    "risk_factors": ["high_complexity", "many_dependencies"]
  }
}
```

---

## Acceptance Criteria

- [ ] Every run stores outcome, cost, resources in SQLite analytics DB
- [ ] `fabrik suggest` shows actionable recommendations with confidence scores
- [ ] Suggestions include data backing ("87% confidence from 47 runs")
- [ ] Model recommendation per spec type based on success rate
- [ ] Resource tuning based on p95 memory/CPU usage
- [ ] Specs with <70% success rate flagged for review
- [ ] `_learned` fields auto-populated in spec JSON
- [ ] Analytics exportable to CSV for external analysis
- [ ] Analysis runs daily via CronJob or on-demand

---

## Assumptions

1. **Data volume**: <10k runs/month (SQLite sufficient)
2. **Retention**: 90 days detailed, aggregates kept longer
3. **Privacy**: Run data stays in user's cluster (no external analytics)
4. **Compute**: Analysis runs on dev machine or CI, not in critical path
5. **Accuracy**: Suggestions are probabilistic, not guarantees

---

## Glossary

- **Fingerprint**: Hash of spec content to detect when specs change
- **Confidence**: Statistical confidence in suggestion (0-1)
- **p95**: 95th percentile (95% of runs below this value)
- **Spec quality**: Composite score of success rate, cost efficiency, duration
