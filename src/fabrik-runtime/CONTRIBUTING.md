# Contributing

State command scope explicitly.

- If a command must run from the repo root, say so.
- If a command must run from `src/fabrik-runtime`, say so.
- Do not assume the current working directory in docs or review notes.

## Verification

Run before publishing or merging runtime-package changes.

From `src/fabrik-runtime`:

```bash
bun test ./src
npm pack --dry-run
```

## Packaging rules

- Keep `package.json` `exports` and `files` aligned.
- Publish only the supported entrypoints and package docs.
- If the public import surface changes, update `README.md` in the same change.

## Release notes

From the repo root:

- Manual bootstrap publish uses `node scripts/publish.mjs`.
- Ongoing releases use `.github/workflows/publish-fabrik-runtime.yml` with npm Trusted Publisher.
