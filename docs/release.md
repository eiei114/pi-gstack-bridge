# Release

This package uses npm Trusted Publishing through GitHub Actions OIDC.

## Local verification

```bash
npm ci
npm run ci
pi -e .
```

## Release

1. Bump the version in `package.json`.
2. Update `CHANGELOG.md`.
3. Push `main`.
4. The repository workflow creates the tag/release and dispatches npm publishing.

Do not add `NPM_TOKEN` or `NODE_AUTH_TOKEN` to workflows or repository secrets.
