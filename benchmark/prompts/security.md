---
name: Security Review
version: "1.0"
---

# Security Review

*Check for any security vulnerabilities, data leakage, or insecure defaults.*

- Are API keys or secrets exposed?
- Is user input sanitized?
- Does the implementation respect the `WEBHOOK_SECRET` environment variable?

Score 0–1 where 1 means fully secure.
