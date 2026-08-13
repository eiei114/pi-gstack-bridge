# pi-gstack-bridge

[![CI](https://github.com/eiei114/pi-gstack-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/eiei114/pi-gstack-bridge/actions/workflows/ci.yml)
[![Publish](https://github.com/eiei114/pi-gstack-bridge/actions/workflows/publish.yml/badge.svg)](https://github.com/eiei114/pi-gstack-bridge/actions/workflows/publish.yml)
[![npm](https://img.shields.io/npm/v/pi-gstack-bridge)](https://www.npmjs.com/package/pi-gstack-bridge)
[![npm downloads](https://img.shields.io/npm/dm/pi-gstack-bridge)](https://www.npmjs.com/package/pi-gstack-bridge)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Pi package](https://img.shields.io/badge/Pi-package-7c3aed)](https://pi.dev/packages)
[![Trusted Publishing](https://img.shields.io/badge/npm-Trusted%20Publishing-success)](docs/release.md)

Pi-native agent bridge for gstack. Routes review, challenge, design, and second-opinion work through child Pi sessions instead of directly launching Codex, Claude, or Gemini CLIs.

## What this is

`pi-gstack-bridge` is the routing and safety boundary for [pi-gstack](https://github.com/salarsayyad/pi-gstack). It embeds pi-gstack's skills, safety hooks, compatibility helpers, and commands while filtering its legacy `Agent`/`Task` registrations. The bridge then supplies Pi-routed replacements for those tools. Codex can remain the selected provider/model (`openai-codex/...`), while Pi owns the child launch, authentication, timeout, cancellation, tool allowlist, and Windows executable resolution.

## Features

- Pi-routed `Agent` and `Task` compatibility tools
- `gstack_pi_agent` for specialist work
- `gstack_pi_review` for independent read-only review
- gstack skills, safety hooks, compatibility helpers, and commands without a second gstack extension
- Direct `codex`, `claude`, and `gemini` CLI blocking
- Windows npm-shim-safe Pi CLI resolution
- Local run artifacts and diagnostics

## Install

```bash
pi install npm:pi-gstack-bridge
```

Do **not** load `npm:pi-gstack` separately in the same settings file. The bridge loads its gstack surface internally and removes the duplicate `Agent`/`Task` registrations before Pi validates extension tools. This avoids the startup error `Tool "Agent" conflicts with ...`.

## Quick start

```text
/gstack-bridge:status
/gstack-bridge:doctor
```

The tools are available to gstack workflows automatically:

```json
{
  "task": "Review this branch for production regressions and security issues.",
  "mode": "review",
  "readOnly": true
}
```

## Configuration

| Variable | Purpose |
| --- | --- |
| `PI_GSTACK_BRIDGE_CLI` | Explicit `pi-coding-agent/dist/cli.js` path |
| `PI_GSTACK_BRIDGE_PI_BIN` | Explicit Pi executable or npm shim |
| `GSTACK_PI_BRIDGE_MODEL` | Default child model when the parent has none |
| `GSTACK_PI_BRIDGE_RUN_DIR` | Override local run-artifact directory |

## Package contents

- `extensions/index.ts` — Pi tools, routing prompt, guardrails, commands
- `pi-gstack` dependency — gstack skills, safety hooks, compatibility helpers, and commands, loaded through the bridge
- `lib/pi-launcher.ts` — cross-platform Pi launch-plan resolver
- `lib/runner.ts` — child Pi runner and artifacts
- `lib/policy.ts` — direct-model-CLI and read-only shell policy
- `skills/gstack-pi-bridge/SKILL.md` — gstack routing instructions

## Development

```bash
npm ci
npm run ci
pi -e .
```

## Release

See [docs/release.md](docs/release.md). Publishing uses npm Trusted Publishing; long-lived npm tokens are not supported.

## Security

This package executes Pi child processes with local-user permissions. Read [SECURITY.md](SECURITY.md) before installing it in an untrusted repository.

## Links

- [Architecture](docs/architecture.md)
- [GitHub](https://github.com/eiei114/pi-gstack-bridge)
- [npm](https://www.npmjs.com/package/pi-gstack-bridge)

## License

MIT
