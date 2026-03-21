# Fabrik Runtime

See `src/fabrik-runtime/CONTRIBUTING.md` for contributor verification and packaging rules.

## Packaging
- Keep `src/fabrik-runtime/package.json` `files` in sync with the published runtime surface at all times.
- Whenever a file is added to or removed from `package.json` `exports`, review and update `package.json` `files` in the same change.
- Do not broaden published contents casually; prefer explicit allowlists for shipped entrypoints and docs only.
- Always state command scope explicitly: repo root vs. `src/fabrik-runtime`.
