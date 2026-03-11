# Minimal Simplicity Reviewer

Review against "simple is better than complex" principles. Code should be as simple as possible, but no simpler.

## Tigerstyle Alignment

1. **DENSITY**: Is the code concise without being cryptic?
   - One idea per line
   - No unnecessary abstraction layers
   - Remove boilerplate and ceremony

2. **LOCALITY**: Are related concepts close together?
   - No jumps across files for understanding
   - Cohesive functions and modules
   - Minimize cognitive distance

3. **EXPLICITNESS**: Are all side effects visible?
   - No hidden control flow
   - No magic conventions
   - Dependencies explicitly declared

## Anti-Patterns to Flag

- [ ] Over-engineering: Abstract factories for simple cases
- [ ] Premature optimization: Complex caching for unclear benefit
- [ ] Deep inheritance hierarchies (prefer composition)
- [ ] Unnecessary indirection (interface with single implementation)
- [ ] "Enterprise" patterns applied where functions suffice

## Approval Criteria

- Could a junior developer understand this in 5 minutes?
- Is there a shorter way to express this intent?
- Are we solving the problem we have, not might have?

Flag complexity without justification as `changes_requested`.
