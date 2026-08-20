# Contributing

## Setup

```bash
npm install
npm test
```

## Pull requests

- Keep changes focused and add tests for public behavior.
- Preserve backward compatibility unless the change is planned for a major release.
- Update the README and changelog when the public API changes.
- Run `npm test` and `npm pack --dry-run` before opening a pull request.

## Releases

1. Update the version in `package.json` and `package-lock.json`.
2. Move release notes into a new section in `CHANGELOG.md`.
3. Merge the release commit to `main`.
4. Publish a matching GitHub release, such as `v0.2.0`.

The release workflow publishes through npm Trusted Publishing with provenance. Maintainers should not add long-lived npm tokens to the repository.
