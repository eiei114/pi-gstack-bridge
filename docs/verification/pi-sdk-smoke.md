# Pi SDK 1.2.0 runtime smoke

Run `npm ci` followed by `npm run smoke:pi`. To refresh the committed behavior report and per-case evidence after a successful run, use `node scripts/pi-sdk-smoke.mjs --record`.

The harness starts the installed Pi 1.2.0 CLI as an actual JSON-RPC host with this package's extension loaded. It observes extension command registration, drives the registered bridge tool through Pi's real agent/tool lifecycle, and verifies that the bridge launches a second actual Pi CLI process and returns that process's response. Reload is checked by cleanly stopping one host and verifying registration and a successful bridge response from a second host. Process exit codes, extension errors, RPC protocol output, and unhandled/shutdown diagnostics are asserted.

A local OpenAI-compatible test endpoint supplies deterministic offline completions so the checks make no paid or external inference calls. Only model responses are predetermined: the Pi host and child processes, SDK, extension loader, bridge tool execution, child launch, and lifecycle are not mocked. Each Pi RPC operation has a bounded deadline; cleanup has a separate one-second deadline. Pi configuration, sessions, and bridge run files live in temporary directories, not the user's global Pi settings.

The five cases are `extension_load`, `happy_path`, `error_path`, `reload_cleanup`, and `host_shell`. `host_shell` observes the actual child launch through `process.execPath` and the installed Pi CLI with `shell: false`; on Windows this bypasses a `pi.cmd` shim. `npm run ci` executes the smoke harness, and CI runs on both Linux and Windows.
