# Security Policy

`pi-gstack-bridge` runs child Pi sessions with the same local user permissions as the parent Pi process.

## Reporting

Please report security issues privately through the repository security advisories page rather than opening a public issue.

## Design notes

- Direct external model CLI invocation is blocked.
- Review children are read-only by default.
- Child prompts and outputs are stored locally under `~/.gstack/pi-bridge-runs`.
- Do not include secrets in review prompts or issue reports.

## Supported versions

Only the latest published version receives security fixes.

## Reporting a vulnerability

Open a private security advisory on GitHub, or contact the maintainer by the preferred channel listed in the repository profile.

Please include:

- Affected version
- Impact
- Reproduction steps
- Suggested fix, if known

## Pi package security note

Pi packages can execute code with local user permissions. Review installed packages and avoid running untrusted extensions.
