import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const { buildPiChildArgsForTest, runPiChild } = await import("../lib/runner.ts");

const launchPlan = {
  command: "pi",
  argsPrefix: [],
  envPatch: {},
  source: "configured",
  confidence: "configured",
  shell: false,
  warnings: [],
};

async function makeRunRoot(t) {
  const runRoot = await mkdtemp(path.join(tmpdir(), "pi-bridge-runner-"));
  t.after(() => rm(runRoot, { recursive: true, force: true }));
  return runRoot;
}

test("child Pi arguments disable recursive gstack resources and carry model/tools", () => {
  const args = buildPiChildArgsForTest(
    {
      task: "Review the branch.",
      mode: "review",
      model: "openai-codex/gpt-5-codex",
      thinking: "high",
    },
    { contextFile: "context.md", taskFile: "task.md", systemFile: "system.md" },
    "openai-codex/gpt-5-codex",
    "read,bash,grep,find,ls",
  );

  assert.ok(args.includes("--no-session"));
  assert.ok(args.includes("--no-skills"));
  assert.ok(args.includes("--no-prompt-templates"));
  assert.deepEqual(args.slice(-4), ["-p", "@context.md", "@task.md", "Complete the attached gstack child task and return only the requested markdown report."]);
});

for (const when of ["before the run", "during artifact preparation", "in the startup update"]) {
  test(`abort ${when} prevents Pi child spawn`, async (t) => {
    const runRoot = await makeRunRoot(t);
    const controller = new AbortController();
    const spawn = t.mock.fn(() => { throw new Error("unexpected spawn"); });
    if (when === "before the run") controller.abort();
    const onUpdate = when === "in the startup update" ? () => controller.abort() : undefined;

    const pending = runPiChild({ task: "Review." }, { cwd: runRoot }, controller.signal, onUpdate, {
      runRoot,
      launchPlan,
      spawn,
    });
    // The run has reached its first await (mkdir) but cannot have spawned yet.
    if (when === "during artifact preparation") controller.abort();

    const result = await pending;
    assert.equal(spawn.mock.callCount(), 0);
    assert.match(result.text, /^Pi child aborted\./);
    assert.equal(await readFile(result.details.outputFile, "utf8"), result.text);
  });
}

test("abort after spawn terminates the Pi child and removes the abort listener", async (t) => {
  const runRoot = await makeRunRoot(t);
  const controller = new AbortController();
  const child = new EventEmitter();
  child.kill = t.mock.fn(() => true);

  const result = await runPiChild({ task: "Review." }, { cwd: runRoot }, controller.signal, undefined, {
    runRoot,
    launchPlan,
    spawn: () => {
      // Run after the spawner returns and the runner installs the listener.
      queueMicrotask(() => controller.abort());
      return child;
    },
  });

  assert.equal(child.kill.mock.callCount(), 1);
  assert.deepEqual(child.kill.mock.calls[0].arguments, ["SIGTERM"]);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.match(result.text, /^Pi child aborted\./);
  assert.equal(result.details.exitCode, null);
  assert.equal(await readFile(result.details.outputFile, "utf8"), result.text);
});
