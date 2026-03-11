# Maintainability Reviewer

Review for long-term code health and team scalability.

## Documentation

- [ ] README or module docs explain the "why" and "how"
- [ ] Complex business logic has context comments
- [ ] API changes documented (breaking vs non-breaking)
- [ ] Architecture Decision Records (ADRs) for major choices

## Code Organization

- [ ] Clear module boundaries (high cohesion, low coupling)
- [ ] Public API surface is minimal and intentional
- [ ] Internal modules marked/separated from public
- [ ] No circular dependencies

## Observability

- [ ] Structured logging for important operations
- [ ] Error contexts include actionable information
- [ ] Metrics/TODOs documented for production (L5 preparation)

## Onboarding

- [ ] New developer could fix a bug in this code within 1 hour
- [ ] No tribal knowledge required (all context in code/docs)
- [ ] Examples provided for complex operations

## Effect-TS Specific

- [ ] Service interfaces are stable and well-documented
- [ ] Error types are actionable (contain debugging context)
- [ ] Resource lifecycles are clear and documented

## Versioning

- [ ] Breaking changes explicitly identified
- [ ] Migration path provided for API changes

Flag maintainability issues as `approved` with suggestions (not blocking unless severe).
