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

async function runWithOutput(t, streams) {
  const runRoot = await makeRunRoot(t);
  const child = new EventEmitter();
  child.kill = () => true;
  for (const [name] of streams) child[name] ??= new EventEmitter();
  const result = await runPiChild({ task: "Review." }, { cwd: runRoot }, undefined, undefined, {
    runRoot,
    launchPlan,
    spawn: () => {
      queueMicrotask(() => {
        for (const [name, chunk] of streams) child[name].emit("data", chunk);
        child.emit("close", 0, null);
      });
      return child;
    },
  });
  assert.equal(result.details.exitCode, 0);
  assert.equal(await readFile(result.details.outputFile, "utf8"), result.text);
  return result.text;
}

test("split UTF-8 is decoded independently on stdout and stderr", async (t) => {
  const out = Buffer.from("日本語");
  const err = Buffer.from("🧪確認");
  const text = await runWithOutput(t, [
    ["stdout", out.subarray(0, 1)],
    ["stderr", err.subarray(0, 2)],
    ["stdout", out.subarray(1)],
    ["stderr", err.subarray(2, 3)],
    ["stderr", err.subarray(3)],
  ]);
  assert.equal(text, "日本語\n🧪確認");
});

test("a child with only stderr flushes an unfinished UTF-8 sequence", async (t) => {
  const partial = Buffer.from("界").subarray(0, 2);
  const text = await runWithOutput(t, [["stderr", "incomplete: "], ["stderr", partial]]);
  assert.equal(text, "incomplete: \uFFFD");
});

test("a child with only stdout retains the bounded tail and truncation marker", async (t) => {
  const limit = 50 * 1024;
  const bytes = Buffer.from("界".repeat(2 * limit));
  const text = await runWithOutput(t, [
    ["stdout", "discarded prefix"],
    ["stdout", bytes.subarray(0, 1)],
    ["stdout", bytes.subarray(1)],
  ]);
  assert.equal(text, `${"界".repeat(limit)}\n\n[output truncated]`);
});

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
