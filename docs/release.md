# Release

This package uses npm Trusted Publishing through GitHub Actions OIDC.

## Local verification

```bash
npm ci
npm run ci
pi -e .
```

## First publish bootstrap

The first publish must be performed once from a logged-in developer machine because npm cannot attach a Trusted Publisher to a package that does not exist yet:

```bash
npm login --auth-type=web
npm publish --access public
```

After the package exists, open its npm settings and add a GitHub Actions Trusted Publisher:

- Organization or user: `eiei114`
- Repository: `pi-gstack-bridge`
- Workflow filename: `publish.yml`
- Environment: empty
- Allowed action: `npm publish`

Do not copy the local npm credential into GitHub. All later releases use the workflow's short-lived OIDC credential.

## Release

1. Bump the version in `package.json`.
2. Update `CHANGELOG.md`.
3. Push `main`.
4. The repository workflow creates the tag/release and dispatches npm publishing.

Do not add `NPM_TOKEN` or `NODE_AUTH_TOKEN` to workflows or repository secrets.
