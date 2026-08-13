---
name: gstack-pi-bridge
description: Enforce Pi-native routing for gstack specialist, review, challenge, consult, and design work. Use whenever a gstack workflow would otherwise launch Codex, Claude, Gemini, Agent, or Task as a separate reviewer.
---

# gstack Pi Bridge

All gstack model work runs through Pi.

## Required routing

- Use `gstack_pi_review` for independent code or plan review.
- Use `gstack_pi_agent` for specialist, adversarial, design, or consultation work.
- `Agent` and `Task` are compatibility aliases and are already routed through the same Pi child launcher.
- Select a different Pi provider/model for a second opinion. Do not launch `codex`, `claude`, or `gemini` from Bash.

## Forbidden routing

Never run:

```text
codex exec ...
codex review ...
claude ...
gemini ...
```

The bridge blocks direct model CLI calls. This is intentional: Pi owns model selection, authentication, cancellation, tool boundaries, and child-process resolution.

## Review defaults

- Child context is fresh and independent.
- Review runs are read-only by default.
- Findings must include evidence and concrete file/line references where possible.
- The child must not call another agent or modify repository files.

## Diagnostics

- `/gstack-bridge:status` — show routing and launch plan.
- `/gstack-bridge:doctor` — run a harmless Pi CLI smoke test.
