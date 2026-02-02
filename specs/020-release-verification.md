# PRD: Release Verification Pipeline

## Overview
Verify every new release of configured open‑source dependencies via a GitHub release webhook. The pipeline performs security analysis, backwards compatibility scoring, and build reproducibility checks. Output is a mandatory JSON report and a PDF security report stored in object storage and attached to email notifications.

## Goals
- Trigger verification on GitHub release webhook events.
- Produce a complete, mandatory verification report for each release.
- Run Trail of Bits Skills security analysis and attach PDF output.
- Provide a clear “Freigabe” decision (Ja/Nein/Manuelle Prüfung) validated by AI reviewers.
- Emit structured output that can be sent via email and later to other channels.

## Non‑Goals
- No UI for configuration or results (handled in later PRD).
- No additional persistence beyond the run store and PDF storage.

## Trigger
- GitHub Release webhook only.
- Webhook payload is forwarded internally as a `jobId: release-verification` task.
- Webhook responds 202 and processes asynchronously.

## Inputs (from GitHub Webhook)
Minimum required:
- `repository.full_name`
- `release.tag_name`
- `release.name`
- `release.body`
- `release.html_url`
- `release.published_at`

## Output Format (JSON)
```json
{
  "repo": "owner/name",
  "release": {
    "version": "v1.2.3",
    "name": "...",
    "url": "...",
    "published_at": "ISO-8601"
  },
  "verification": {
    "freigabe": "Ja" | "Nein" | "Manuelle Prüfung",
    "security": {
      "score": 0,
      "findings": {
        "high": ["..."],
        "medium": ["..."]
      },
      "pdf": {
        "storage_url": "...",
        "sha256": "..."
      }
    },
    "backwards_compatibility": {
      "score": 0,
      "blockers": ["..."],
      "high_risk": ["..."]
    },
    "reproducible_build": {
      "verified": true,
      "details": "...",
      "artifact_hash": "...",
      "commit_hash": "..."
    }
  },
  "summaries": {
    "title": "UPDATE: {Software}: vX.Y.Z - {description}",
    "end_user": "Was ändert sich für mich...",
    "maintainer": "Was hat sich technisch geändert..."
  },
  "review": {
    "reviewers": 5,
    "approved": 4,
    "notes": ["..."],
    "iterations": 1
  }
}
```

## Mandatory Checks
1) **Security analysis**
   - Run Trail of Bits Skills:
     - `trailofbits-skills/plugins/static-analysis/README.md`
     - `trailofbits-skills/plugins/insecure-defaults/README.md`
     - `trailofbits-skills/plugins/differential-review/README.md`
   - Use the skills content as prompt input in v1 (no direct tooling execution).
   - Produce a PDF report (A4).
   - Include score (0–100) and list all High + Medium findings.

2) **Backwards compatibility**
   - Score 0–100 (AI‑scored in v1).
   - List high‑risk changes and blockers.

3) **Reproducible build**
   - Verify that built artifacts match released commit/hash.
   - Use Ralph/CLI to discover build steps when needed.
   - Report `verified` boolean and relevant hashes.
   - If verification fails, set `freigabe` to “Manuelle Prüfung”.

4) **Summaries**
   - End‑user summary (“Was ändert sich für mich”).
   - Maintainer summary (“Was hat sich technisch geändert”).

## AI Workflow
- Use @effect/ai with OpenAI provider for:
  - Summary generation
  - Risk classification
  - Reviewer loop to validate completeness and quality
- Reviewer loop requirements:
  - 5 reviewers, 4 approvals required
  - Max iterations: 3

## Storage
- Security PDF is stored in S3‑compatible object storage with:
  - URL returned in JSON
  - SHA‑256 checksum stored in JSON
  - PDF naming: `YYYY-MM-DD-reponame.pdf`

## Notifications (Email Only)
- Email is sent to a configurable distribution list.
- PDF attached.
- Email body uses the JSON report to render the formatted output.
- Use Effect dependency injection to keep notification providers abstracted.
- SMTP transport for v1 (config via env).
- Email format: HTML.

## Configuration
- `RELEASE_WEBHOOK_SECRET` for webhook auth.
- `REVIEWERS`, `REVIEW_APPROVALS_REQUIRED`, `REVIEW_MAX_ITERATIONS`.
- Object storage credentials (S3 compatible).
- Email transport configuration (SMTP).
- Repo allowlist (explicitly define which repos are monitored).
- Per-repo email recipient list (configurable via UI).
- `GITHUB_TOKEN` for fetching release metadata and diffs if needed.
- SMTP envs: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`.

## Acceptance Criteria
- A GitHub release webhook triggers the pipeline end‑to‑end.
- JSON report includes all mandatory fields.
- PDF stored and linked with checksum.
- Email sent with attached PDF and formatted summary.
- Reviewer loop completes or hits max iterations with clear outcome.

## Explicit Assumptions
- Release verification is triggered only by GitHub release webhook (no polling).
- Trail of Bits Skills plugins listed are mandatory.
- Backwards compatibility score is AI‑based in v1.
- Reproducible build is attempted via Ralph; failures result in “Manuelle Prüfung.”
- S3 provider is AWS‑compatible (exact vendor TBD).

## Open Questions
- How to validate reproducible builds for each repo (build system variability)?
- Which S3 provider to use initially (AWS, MinIO, R2)?
