# Changelog

## Unreleased

### Fixed

- Do not launch a Pi child if its run was cancelled before or during startup preparation.
- Preserve UTF-8 characters split across Pi child stdout or stderr chunks in the result and `output.txt`.
- Keep the Pi SDK smoke run from hanging forever when a Pi host survives cleanup on a loaded Windows machine; the run now releases the host's pipes and exits within a fixed deadline.

## [0.1.6] - 2026-11-07

### Changed

- Pin the Pi SDK development dependencies to 1.5.0 and verify the bridge against the actual Pi host.

## [0.1.5] - 2026-11-07

### Fixed

- Derive Pi SDK smoke expectations from the exact development dependency pins so compatible SDK updates do not fail against stale hard-coded versions.

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
