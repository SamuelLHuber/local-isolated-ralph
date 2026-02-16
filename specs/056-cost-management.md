# Spec: Cost Management

> Track infrastructure spend, estimate costs before deployment, alert on budget thresholds

**Status**: draft  
**Version**: 1.0.0  
**Last Updated**: 2026-02-16  
**Depends On**: `050-k3s-infrastructure`, `051-k3s-orchestrator`  
**Provides**: Cost visibility and control for Hetzner + LLM spend

---

## Changelog

- **v1.0.0** (2026-02-16): Initial specification

---

## Identity

**What**: Cost tracking for:
1. **Infrastructure**: Hetzner Cloud servers, volumes, load balancers
2. **LLM Usage**: Per-run Anthropic/OpenAI token costs (from Smithers)
3. **Estimation**: Preview costs before `fabrik infra up` or run dispatch

**Why**: Cloud costs surprise you. We show costs upfront and alert on thresholds.

**Not**: 
- Enterprise billing (invoices, payment processing)
- Multi-cloud cost aggregation (start with Hetzner)
- Reserved instance optimization (can add later)

---

## Goals

1. **Pre-deploy estimation**: Show monthly cost before `fabrik infra up`
2. **Real-time tracking**: Current spend via `fabrik cost show`
3. **Budget alerts**: Webhook/email when spend exceeds threshold
4. **Per-run attribution**: LLM costs attached to specific runs
5. **Cost breakdown**: By cluster, project, run type (impl vs review)

---

## Non-Goals

- Payment processing or invoicing
- Multi-cloud cost aggregation (AWS + GCP + Hetzner)
- Spot instance optimization
- Automated cost optimization (rightsizing, deletion)

---

## Architecture

```
┌─ Cost Management ────────────────────────────────────────────────────────┐
│                                                                            │
│  ┌─ Data Sources ───────────────────────────────────────────────────────┐ │
│  │                                                                          │ │
│  │  ┌─ Hetzner API ──────────────────────────────────────────────────┐ │ │
│  │  │  GET /v1/servers, /v1/volumes, /v1/load_balancers             │ │ │
│  │  │  Prices from Hetzner pricing API                               │ │ │
│  │  │  Cached: ~/.cache/fabrik/pricing/hetzner.json                  │ │ │
│  │  └───────────────────────────────────────────────────────────────────┘ │ │
│  │                                                                          │ │
│  │  ┌─ Smithers Metrics ──────────────────────────────────────────────┐ │ │
│  │  │  Token usage per run: input_tokens, output_tokens               │ │ │
│  │  │  Model pricing from Anthropic/OpenAI public APIs                 │ │ │
│  │  │  Stored: Prometheus metrics (LAOS) or pod annotations            │ │ │
│  │  └───────────────────────────────────────────────────────────────────┘ │ │
│  │                                                                          │ │
│  └──────────────────────────────────────────────────────────────────────────┘ │
│                              │                                             │
│                              ▼                                             │
│  ┌─ Calculation ──────────────────────────────────────────────────────────┐ │
│  │  Infrastructure: sum(server_count * hourly_price * hours_running)    │ │
│  │  Storage: sum(volume_size_gb * gb_monthly_price)                      │ │
│  │  Network: Hetzner has no egress charges (€0)                          │ │
│  │  LLM: sum(input_tokens * input_price + output_tokens * output_price)│ │
│  └──────────────────────────────────────────────────────────────────────────┘ │
│                              │                                             │
│                              ▼                                             │
│  ┌─ Storage ─────────────────────────────────────────────────────────────┐ │
│  │  SQLite: ~/.cache/fabrik/costs.db                                     │ │
│  │  ├─ daily_spend: Date, category, amount                               │ │
│  │  ├─ run_costs: Run ID, LLM cost, duration, infrastructure alloc      │ │
│  │  └─ budgets: Category, limit, alert_threshold_percent                │ │
│  └──────────────────────────────────────────────────────────────────────────┘ │
│                                                                            │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Hetzner Pricing Integration

**Pricing Model** (as of 2026-02):

| Resource | Type | Price (€/month) |
|----------|------|-----------------|
| CX21 | 2 vCPU, 8GB RAM | €5.35 |
| CX31 | 4 vCPU, 16GB RAM | €10.70 |
| CX41 | 8 vCPU, 32GB RAM | €21.40 |
| CX51 | 16 vCPU, 64GB RAM | €42.80 |
| CPX21 | 4 vCPU (dedicated), 8GB | €8.60 |
| Volume | 1 GB storage | €0.044 |
| LB11 | Load balancer | €6.00 |
| Traffic | Egress | €0.00 (unlimited) |

**Price Fetching:**

```typescript
// Fetch and cache Hetzner pricing
async function fetchHetznerPricing(): Promise<Pricing> {
  const cached = readCache('hetzner-pricing.json');
  if (cached && cached.age < 24 * 60 * 60 * 1000) {
    return cached.data;
  }
  
  // Hetzner pricing is public but not API-exposed
  // We maintain a JSON file in repo, updated periodically
  const pricing = await fetch('https://raw.githubusercontent.com/fabrik/hetzner-pricing/main/pricing.json');
  writeCache('hetzner-pricing.json', pricing);
  return pricing;
}
```

---

## LLM Cost Attribution

**Smithers reports token usage via annotations:**

```yaml
# Pod annotation from Smithers
metadata:
  annotations:
    fabrik.dev/llm-cost: '{
      "model": "claude-3-5-sonnet-20241022",
      "input_tokens": 15000,
      "output_tokens": 8500,
      "input_cost_usd": 0.045,
      "output_cost_usd": 0.1275,
      "total_cost_usd": 0.1725,
      "currency": "USD"
    }'
```

**Pricing Configuration:**

```typescript
// LLM pricing (updated periodically, cached locally)
interface LlmPricing {
  provider: 'anthropic' | 'openai';
  model: string;
  inputPricePer1k: number;  // USD
  outputPricePer1k: number; // USD
  validFrom: string;        // ISO date
}

const llmPricing: LlmPricing[] = [
  { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022', 
    inputPricePer1k: 0.003, outputPricePer1k: 0.015 },
  { provider: 'anthropic', model: 'claude-3-opus-20240229', 
    inputPricePer1k: 0.015, outputPricePer1k: 0.075 },
  { provider: 'openai', model: 'gpt-4o', 
    inputPricePer1k: 0.005, outputPricePer1k: 0.015 },
];
```

---

## CLI Commands

```bash
# Pre-deploy estimation
fabrik infra up --dry-run  # Shows estimated monthly cost
# Output: "Estimated cost: €42.80/month (1× CX51 + 100GB volume + LB11)"

# Show current spend
fabrik cost show
# Output:
# Infrastructure (dev-k3s): €32.10/month (running: 6 days)
#  - Servers: €21.40 (1× CX41)
#  - Storage: €4.40 (100GB)
#  - LB: €6.00 (1× LB11)
#  - Projected monthly: €32.10
#
# LLM Usage (last 30 days): $127.50
#  - Claude 3.5 Sonnet: $89.20 (45 runs)
#  - Claude 3 Opus: $38.30 (3 runs)
#
# Total: €32.10 + $127.50 ≈ $160/month

# Show by project
fabrik cost show --project myapp --last-30d

# Show by run
fabrik cost show --run-id 01jk7v8x...

# Set budget
fabrik budget set --category infrastructure --limit-eur 100 --alert-at 80
fabrik budget set --category llm --limit-usd 500 --alert-at 90

# Check budget status
fabrik budget status
# Output:
# infrastructure: €32.10 / €100 (32%) ✓
# llm: $127.50 / $500 (25%) ✓

# Export cost report
fabrik cost export --start 2026-01-01 --end 2026-02-01 --format csv > costs.csv
```

---

## Configuration

```yaml
# ~/.config/fabrik/cost.yaml
pricing:
  hetzner:
    # Auto-fetched, can override
    cx21_monthly_eur: 5.35
    volume_gb_monthly_eur: 0.044
  
  llm:
    anthropic:
      claude-3-5-sonnet-20241022:
        input_per_1k: 0.003
        output_per_1k: 0.015

budgets:
  infrastructure:
    limit_eur: 100
    alert_threshold_percent: 80
    alert_webhook: https://hooks.slack.com/...
  
  llm:
    limit_usd: 500
    alert_threshold_percent: 90
    alert_webhook: https://hooks.slack.com/...

currency:
  display: combined  # Show both EUR and USD
  conversion_rate: auto  # Fetch EUR/USD rate
```

---

## Alerting

**Budget Alert Webhook:**

```typescript
interface BudgetAlert {
  type: 'budget_threshold';
  severity: 'warning';  // At threshold, 'critical' at limit
  timestamp: string;
  
  budget: {
    category: 'infrastructure' | 'llm';
    limit: number;
    currency: 'EUR' | 'USD';
    current_spend: number;
    percent_used: number;
    projected_monthly: number;  // If continues at current rate
  };
  
  details: {
    days_into_period: number;
    projected_over_limit: boolean;
    recommendation?: string;  // "Consider downsizing CX41 to CX31"
  };
}
```

---

## TUI Integration

```
┌─ Cost Dashboard ──────────────────────────────────────────────────────────┐
│                                                                            │
│  Current Month (Feb 2026)                                                 │
│  ┌─ Infrastructure ─────────────────────────────┐  ┌─ LLM Usage ──────────┐│
│  │  €32.10 / €100 budget (32%)                │  │  $127.50 / $500     ││
│  │  ████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░ │  │  █████░░░░░░░░░░░   ││
│  │                                              │  │  25% used           ││
│  │  Servers: €21.40 (1× CX41)                  │  │                     ││
│  │  Storage: €4.40 (100GB)                    │  │  Sonnet: $89.20     ││
│  │  LB: €6.00                                  │  │  Opus: $38.30       ││
│  │  Projected: €48/month                      │  │  45 runs tracked    ││
│  └──────────────────────────────────────────────┘  └─────────────────────┘│
│                                                                            │
│  Top Costs (Last 30 Days)                                                 │
│  NAME              │ TYPE    │ INFRA   │ LLM     │ TOTAL                  │
│  run-01jk7v8x...   │ impl    │ €0.72   │ $12.40  │ $13.42                 │
│  run-01jk8a2y...   │ review  │ €0.24   │ $4.20   │ $4.56                  │
│  cron-nightly      │ backup  │ €0.04   │ $0      │ €0.04                  │
│                                                                            │
├────────────────────────────────────────────────────────────────────────────┤
│ [r] refresh │ [e] export │ [b] budgets │ [←] back                            │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## Acceptance Criteria

- [ ] `fabrik infra up --dry-run` shows estimated monthly infrastructure cost
- [ ] `fabrik cost show` displays current infrastructure + LLM spend
- [ ] LLM costs attributed per run via Smithers annotations
- [ ] Hetzner pricing cached locally, updated periodically
- [ ] Budget alerts fired at configured threshold (default 80%)
- [ ] Webhook receives alert with category, current, limit, projection
- [ ] `fabrik budget set` configures limits per category
- [ ] `fabrik cost export` generates CSV/JSON reports
- [ ] TUI dashboard shows cost breakdown with progress bars
- [ ] Currency conversion EUR/USD using live rates (cached)

---

## Assumptions

1. **Hetzner pricing**: Stable, cached locally (update monthly)
2. **LLM pricing**: From provider public APIs, cached daily
3. **Currency**: EUR for Hetzner, USD for LLMs (convert for display)
4. **Tax**: Not included (prices ex-VAT)
5. **Network**: Hetzner has no egress charges (simplifies calculation)

---

## Glossary

- **CapEx**: Capital expenditure (server purchases - not applicable, we use OpEx)
- **OpEx**: Operational expenditure (monthly cloud spend)
- **Egress**: Data transfer out (€0 for Hetzner)
- **Attribution**: Assigning costs to specific runs/projects
- **Projection**: Estimated monthly cost if current rate continues
