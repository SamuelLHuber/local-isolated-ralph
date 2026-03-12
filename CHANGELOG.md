# Changelog

## v0.1.0 - 2026-03-12

### Highlights

- Added `fabrik version` with embedded version, commit, build date, and platform metadata.
- Switched the `fabrik` release workflow to build the Go CLI directly from `src/fabrik-cli`.
- Documented GitHub Releases installation, supported binary artifact names, checksum verification, and the v0.1.0 release process.

### Artifacts

- `fabrik-darwin-arm64`
- `fabrik-linux-x64`
- `fabrik-linux-arm64`
- `fabrik-sha256.txt`

### Operator Notes

- GitHub Releases is the canonical install source for `fabrik` binaries.
- Release tags use the `vX.Y.Z` form, while `fabrik version` reports the embedded semantic version such as `0.1.0`.

### Verification

- `bun test workflows/todo-driver.test.ts workflows/utils/k8s-jobs.test.ts`
- `make verify-cli`
