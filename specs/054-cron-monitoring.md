# Spec: Cron Monitoring

> Detect missed runs, duration alerts, and health checks for scheduled jobs

**Status**: draft  
**Version**: 1.0.0  
**Last Updated**: 2026-02-16  
**Depends On**: `051-k3s-orchestrator`  
**Provides**: Reliability for scheduled (CronJob) workloads

---

## Changelog

- **v1.0.0** (2026-02-16): Initial specification

---

## Identity

**What**: Monitoring system for CronJobs that:
1. **Detects missed runs** - Alert when scheduled job doesn't start
2. **Duration monitoring** - Alert when job runs longer than expected
3. **Health integration** - Status visible in `fabrik dashboard`

**Why**: CronJobs can fail silently. Without monitoring, you only notice when something breaks.

**Not**: 
- Job scheduling (K8s CronJob handles that)
- Complex dependency chains between jobs
- Distributed tracing within jobs

---

## Goals

1. **Missed run detection**: Alert if CronJob misses its schedule
2. **Duration alerts**: Alert if job exceeds expected runtime
3. **Status visibility**: See CronJob health in TUI/Web dashboard
4. **Simple integration**: Works with existing K8s CronJobs, no SDK required
5. **Multiple alert methods**: Webhook, email (via LAOS AlertManager)

---

## Non-Goals

- Complex job dependencies ("Job A must finish before Job B")
- Distributed tracing (future: separate spec)
- Automatic retry of failed CronJobs (K8s handles this)
- SLA/SLO tracking (deferred to v2)

---

## Architecture

```
┌─ Fabrik Cron Monitoring ─────────────────────────────────────────────────┐
│                                                                          │
│  ┌─ Data Collection ───────────────────────────────────────────────────┐ │
│  │  Kubernetes CronJob API (via @kubernetes/client-node)              │ │
│  │  └── Lists CronJobs, checks status.lastScheduleTime vs now         │ │
│  │                                                                          │ │
│  ├─ SQLite State (~/.cache/fabrik/cron-monitor.db)                     │ │
│  │  ├─ monitors: CronJob name, schedule, expected duration            │ │
│  │  ├─ history: Last run start/end time, status                       │ │
│  │  └─ alerts: Missed runs, duration violations                        │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                              │                                           │
│                              ▼                                           │
│  ┌─ Monitor Loop (every minute) ────────────────────────────────────────┐ │
│  │  For each monitored CronJob:                                         │ │
│  │    1. Check lastScheduleTime vs expected schedule                   │ │
│  │    2. If > 2x schedule interval → "missed_run" alert                │ │
│  │    3. Check running jobs duration vs expected                       │ │
│  │    4. If > expected + margin → "duration_exceeded" alert            │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                              │                                           │
│                              ▼                                           │
│  ┌─ Alerting ───────────────────────────────────────────────────────────┐ │
│  │  Webhook → LAOS AlertManager → PagerDuty/Slack/Email                │ │
│  │  Or: Direct webhook to user-provided URL                             │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Configuration

```typescript
// Cron monitoring configuration
interface CronMonitorConfig {
  // Schedule in crontab format or "@hourly", "@daily", etc.
  schedule: string;
  
  // Expected duration (alert if exceeded)
  expectedDuration: {
    minutes: number;
    // Margin of error before alerting (0.2 = 20% over is OK)
    marginPercent: number;
  };
  
  // Missed run detection
  missedRunThreshold: {
    // Alert after N missed schedules
    consecutiveMisses: number;
    // Or after M minutes past expected start
    minutesLate: number;
  };
  
  // Alert destinations
  alerts: {
    webhook?: string;  // POST to this URL
    email?: string;      // Via LAOS/AlertManager
    slack?: string;      // Webhook URL
  };
}

// Example
const nightlyBackup: CronMonitorConfig = {
  schedule: "0 2 * * *",  // 2 AM daily
  expectedDuration: { minutes: 30, marginPercent: 0.5 },  // 45 min max
  missedRunThreshold: { consecutiveMisses: 1, minutesLate: 15 },
  alerts: { webhook: "https://hooks.slack.com/..." }
};
```

---

## CLI Commands

```bash
# Enable monitoring for a CronJob
fabrik cron monitor create --name nightly-backup \
  --schedule "0 2 * * *" \
  --expected-duration 30m \
  --alert-webhook https://hooks.slack.com/...

# List monitored CronJobs
fabrik cron monitor list

# View history for a CronJob
fabrik cron history --name nightly-backup

# Show last 10 runs
fabrik cron history --name nightly-backup --limit 10

# Check health now (manual)
fabrik cron check --name nightly-backup

# Disable monitoring
fabrik cron monitor disable --name nightly-backup
fabrik cron monitor enable --name nightly-backup

# Delete monitoring
fabrik cron monitor delete --name nightly-backup
```

---

## Integration with TUI/Web Dashboard

**TUI View (`fabrik dashboard` in `:cron` mode):**

```
┌─ Cron Jobs ─────────────────────────────────────────────────────────────┐
│ NAME            │ SCHEDULE   │ LAST RUN │ STATUS   │ NEXT   │ HEALTH  │
├─────────────────┼────────────┼──────────┼──────────┼────────┼─────────┤
│ nightly-backup  │ 0 2 * * *  │ 2h ago   │ ✓ OK     │ 22h    │ ✓       │
│ hourly-sync     │ 0 * * * *  │ 45m ago  │ ✓ OK     │ 15m    │ ✓       │
│ weekly-report   │ 0 9 * * 1  │ 2d ago   │ ! SLOW   │ 5d     │ ⚠       │
│                 │            │          │ (45min)  │        │ >30min  │
├─────────────────────────────────────────────────────────────────────────┤
│ [h] history │ [d] details │ [m] mute alerts │ [?] help                  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Missed Run Detection

**Algorithm:**

```typescript
function checkMissedRun(cronJob: V1CronJob, monitor: CronMonitor): Alert | null {
  const lastSchedule = cronJob.status?.lastScheduleTime;
  if (!lastSchedule) {
    return { type: 'never_run', severity: 'warning' };
  }
  
  const schedule = parseCron(monitor.config.schedule);
  const expectedNext = schedule.getNext(lastSchedule);
  const now = new Date();
  
  // Missed if: now > expectedNext + threshold
  const thresholdMinutes = monitor.config.missedRunThreshold.minutesLate;
  const thresholdMs = thresholdMinutes * 60 * 1000;
  
  if (now.getTime() > expectedNext.getTime() + thresholdMs) {
    return {
      type: 'missed_run',
      severity: 'critical',
      message: `CronJob ${monitor.name} missed scheduled run at ${expectedNext}`,
      details: {
        expectedAt: expectedNext,
        actualStatus: cronJob.status?.active ? 'running' : 'unknown',
        minutesLate: Math.floor((now.getTime() - expectedNext.getTime()) / 60000)
      }
    };
  }
  
  return null;
}
```

---

## Duration Monitoring

**Algorithm:**

```typescript
function checkDuration(pod: V1Pod, monitor: CronMonitor): Alert | null {
  if (pod.status?.phase !== 'Running') return null;
  
  const startTime = new Date(pod.status?.startTime!);
  const now = new Date();
  const durationMinutes = (now.getTime() - startTime.getTime()) / 60000;
  
  const expected = monitor.config.expectedDuration.minutes;
  const margin = monitor.config.expectedDuration.marginPercent;
  const threshold = expected * (1 + margin);
  
  if (durationMinutes > threshold) {
    return {
      type: 'duration_exceeded',
      severity: 'warning',
      message: `CronJob ${monitor.name} running for ${durationMinutes.toFixed(1)}min (expected ${expected}min)`,
      details: {
        expectedMinutes: expected,
        actualMinutes: durationMinutes,
        podName: pod.metadata?.name
      }
    };
  }
  
  return null;
}
```

---

## Alerting Webhook Format

```typescript
interface CronAlertWebhook {
  alert: 'missed_run' | 'duration_exceeded' | 'failed' | 'never_run';
  severity: 'warning' | 'critical';
  timestamp: string;  // ISO 8601
  
  cronJob: {
    name: string;
    namespace: string;
    schedule: string;
    cluster: string;
  };
  
  details: {
    expectedAt?: string;      // For missed_run
    minutesLate?: number;     // For missed_run
    expectedMinutes?: number; // For duration_exceeded
    actualMinutes?: number;   // For duration_exceeded
    exitCode?: number;        // For failed
    logs?: string;            // Last 100 lines (optional)
  };
  
  // Link to Fabrik dashboard
  fabrikUrl: string;  // http://localhost:3000/crons/nightly-backup
}
```

---

## Acceptance Criteria

- [ ] `fabrik cron monitor create` adds CronJob to monitoring with schedule validation
- [ ] Missed run detected within configured threshold (default: 15 min past schedule)
- [ ] Duration alert fired when job exceeds expected + margin
- [ ] Webhook POSTs to configured URL with full alert context
- [ ] Alert includes link to Fabrik dashboard for investigation
- [ ] `fabrik cron list` shows all monitored CronJobs with health status
- [ ] `fabrik cron history` shows last N runs with duration and exit status
- [ ] Works with any K8s CronJob (no SDK integration required in job)
- [ ] SQLite storage for monitor state (survives Fabrik CLI restart)
- [ ] No separate daemon: monitoring runs as part of `fabrik daemon` or on-demand

---

## Assumptions

1. **K8s CronJob**: Target CronJob exists and has valid schedule
2. **Clock sync**: K8s node clocks synchronized (NTP)
3. **Permissions**: Can read CronJob status across namespaces
4. **Alert endpoint**: Webhook/AlertManager reachable from Fabrik CLI
5. **Schedule format**: Standard crontab or K8s CronJob shorthand (@hourly, etc.)

---

## Glossary

- **CronJob**: K8s batch/v1 CronJob - schedules Jobs
- **Missed run**: Scheduled time passed but no Job created
- **Duration alert**: Job running longer than expected
- **Margin**: Percentage tolerance before alerting (20% = OK if 12 min for 10 min expected)
- **AlertManager**: Prometheus AlertManager (part of LAOS) for routing alerts
