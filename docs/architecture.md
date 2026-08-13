# Architecture

## Boundary

`pi-gstack-bridge` owns the AI-agent boundary for gstack. It does not replace ordinary subprocesses such as Git, Bun, Playwright, or test runners.

```text
gstack skill
  -> gstack_pi_agent / gstack_pi_review / Agent / Task
    -> Pi launch plan
      -> child Pi
        -> configured provider/model
```

Codex remains usable as a Pi provider/model (`openai-codex/...`). The Codex CLI is not used.

## Windows launch resolution

The resolver prefers the current Pi process entrypoint (`pi-coding-agent/dist/cli.js`) and invokes it with Node. This avoids relying on a shell-visible `pi` command or an npm `.cmd` shim. Explicit `PI_GSTACK_BRIDGE_CLI` and `PI_GSTACK_BRIDGE_PI_BIN` overrides are supported, followed by npm/PATH candidates.

The selected plan contains:

- `command`
- `argsPrefix`
- environment patch
- source and confidence
- shell requirement
- warnings

No global PATH or shell profile is modified.

## Safety

- Parent sessions block direct `codex`, `claude`, and `gemini` CLI invocations from both agent Bash tool calls and user Bash commands.
- Child review sessions receive no edit/write tools.
- Read-only child Bash commands are checked for common mutation patterns.
- Run artifacts remain under `~/.gstack/pi-bridge-runs` unless `GSTACK_PI_BRIDGE_RUN_DIR` is set.
