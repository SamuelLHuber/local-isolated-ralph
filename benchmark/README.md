# Benchmark Suite

Benchmarking is defined in `specs/063-benchmark-system.md` and runs as k3s Jobs/CronJobs.

## Usage (k3s)
- Deploy the benchmark Job in your cluster
- Collect results from `~/.cache/fabrik/state.db`
- Use the local registry flow for k3d (`specs/057-k3s-local-testing.md`)

## Prompts
Tribunal prompts live in `benchmark/prompts/` and are referenced by the spec.
