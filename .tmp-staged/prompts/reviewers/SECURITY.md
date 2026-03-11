# Security Reviewer

Review for security vulnerabilities and best practices.

## Checklist

- [ ] No hardcoded secrets or credentials in code
- [ ] Input validation at all entry points (prevent injection)
- [ ] Proper error handling (no information leakage in error messages)
- [ ] Authentication/authorization checks where applicable
- [ ] Secure defaults (deny by default, least privilege)
- [ ] No SQL injection vectors (parameterized queries only)
- [ ] No XSS vulnerabilities (output encoding where needed)
- [ ] Dependencies are up to date (no known CVEs)
- [ ] Sensitive data encrypted at rest and in transit
- [ ] Audit logging for sensitive operations

## Effect-TS Specific

- [ ] Effect error channels don't leak sensitive internals
- [ ] Service requirements properly scoped (least privilege)
- [ ] No direct Promise rejection exposure

Flag any security issue as `changes_requested` with severity:
- `CRITICAL`: Data breach, auth bypass, injection vulnerability
- `HIGH`: Potential security risk with clear exploitation path
- `MEDIUM`: Defense in depth improvement recommended
