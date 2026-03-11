# Specs of the Fabrik 

## Specs
- `050-k3s-infrastructure` - Terraform/OpenTofu + NixOS provisioning for k3s clusters (Hetzner-first).
- `051-k3s-orchestrator` - K8s-native execution model for Fabrik Jobs/CronJobs, storage, secrets, observability.
- `052-k3s-orchestrator-dashboard` - Web + TUI dashboards that talk directly to the K8s API.
- `054-cron-monitoring` - Missed-run detection and duration/health alerts for CronJobs.
- `055-run-analytics` - Collect/run analytics to improve specs, resources, and success rates.
- `056-cost-management` - Infra + LLM cost tracking, estimation, and budget alerts.
- `057-k3s-local-testing` - k3d-based local/CI k3s clusters for repeatable tests.
- `060-security-hardening` - Isolation and security controls for multi-tenant k3s clusters.
- `061-incluster-optimizer` - In-cluster self-optimizing agent with A/B testing and auto-tuning.
- `062-fabrik-laos-lint` - LAOS-backed performance lint + run feedback reports.
- `063-benchmark-system` - Benchmarking/tribunal system for models, providers, and performance.
