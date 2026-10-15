# Changelog

## Unreleased

## [0.1.4] - 2026-10-16

### Changed

- Pin Pi SDK development dependencies to 1.2.0 and run live extension compatibility smoke cases in CI on Linux and Windows.

## 0.1.2 - 2026-09-27

- chore: periodic patch bump after 7+ days without npm publish

## [0.1.3] - 2026-09-30

### Changed

- Update `@earendil-works/pi-*` dependencies to `0.99.1`.

## [0.1.1] - 2026-08-30

- Make the bridge own the gstack `Agent` and `Task` compatibility tools.
- Block direct model CLI probes and shell invocations while preserving ordinary subprocesses.
- Remove the obsolete spawnkit compatibility environment patch.

## [0.1.0] - 2026-08-13

- Add Pi-native gstack Agent/Task compatibility routing.
- Add `gstack_pi_agent` and `gstack_pi_review` tools.
- Block direct Codex, Claude, and Gemini CLI invocations.
- Add Windows-aware Pi CLI resolution and smoke diagnostics.
