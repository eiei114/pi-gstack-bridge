import assert from "node:assert/strict";
import test from "node:test";

const { applyPiLaunchPlan, isRunnablePlan, resolvePiLaunchPlan } = await import("../lib/pi-launcher.ts");

function virtualFiles(paths) {
  const normalized = new Set(paths.map((value) => value.replaceAll("\\", "/").toLowerCase()));
  return (value) => normalized.has(value.replaceAll("\\", "/").toLowerCase());
}

test("prefers the current Pi CLI entrypoint over a shell-visible command", () => {
  const cli = "/opt/pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";
  const plan = resolvePiLaunchPlan({
    platform: "linux",
    env: { PATH: "" },
    processArgv: ["/usr/bin/node", cli],
    processExecPath: "/usr/bin/node",
    fileExists: virtualFiles([cli]),
  });

  assert.equal(plan.command, "/usr/bin/node");
  assert.deepEqual(plan.argsPrefix, [cli]);
  assert.equal(plan.source, "current-process");
  assert.equal(plan.shell, false);
  assert.equal(isRunnablePlan(plan), true);
  assert.notEqual(plan.command, "pi");
});

test("uses an explicit Windows Pi CLI path with Node", () => {
  const cli = String.raw`C:\Users\alice\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\dist\cli.js`;
  const plan = resolvePiLaunchPlan({
    platform: "win32",
    env: { PI_GSTACK_BRIDGE_CLI: cli, Path: "C:\\Windows\\System32" },
    processArgv: [],
    processExecPath: String.raw`C:\Program Files\nodejs\node.exe`,
    fileExists: virtualFiles([cli]),
  });

  assert.equal(plan.command, String.raw`C:\Program Files\nodejs\node.exe`);
  assert.deepEqual(plan.argsPrefix, [cli]);
  assert.equal(plan.source, "configured");
  assert.equal(plan.confidence, "configured");
  assert.equal(plan.shell, false);
});

test("translates a Windows npm pi.cmd shim to its Node CLI when available", () => {
  const shim = String.raw`C:\Users\alice\AppData\Roaming\npm\pi.cmd`;
  const cli = String.raw`C:\Users\alice\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\dist\cli.js`;
  const plan = resolvePiLaunchPlan({
    platform: "win32",
    env: { PI_BIN: shim, Path: "" },
    processArgv: [],
    processExecPath: String.raw`C:\Program Files\nodejs\node.exe`,
    fileExists: virtualFiles([shim, cli]),
  });

  assert.equal(plan.command, String.raw`C:\Program Files\nodejs\node.exe`);
  assert.deepEqual(plan.argsPrefix, [cli]);
  assert.equal(plan.shell, false);
  assert.equal(plan.source, "configured");
});

test("returns a fail-closed missing plan when no Pi candidate exists", () => {
  const plan = resolvePiLaunchPlan({
    platform: "win32",
    env: { Path: "" },
    processArgv: [],
    processExecPath: String.raw`C:\Program Files\nodejs\node.exe`,
    fileExists: () => false,
  });

  assert.equal(plan.confidence, "missing");
  assert.equal(isRunnablePlan(plan), false);
  assert.match(plan.warnings.join("\n"), /PI_GSTACK_BRIDGE_CLI/u);
});

test("session environment patch is process-local and idempotent", () => {
  const env = { PATH: "/usr/bin" };
  const cli = "/opt/pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";
  const plan = resolvePiLaunchPlan({
    platform: "linux",
    env,
    processArgv: ["/usr/bin/node", cli],
    processExecPath: "/usr/bin/node",
    fileExists: virtualFiles([cli]),
  });

  applyPiLaunchPlan(plan, env);
  applyPiLaunchPlan(plan, env);
  assert.equal(env.PI_GSTACK_BRIDGE_CLI, cli);
  assert.equal(env.PATH.split(":").filter((entry) => entry === "/opt/pi/node_modules/@earendil-works/pi-coding-agent/dist").length, 1);
});
