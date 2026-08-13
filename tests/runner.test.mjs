import assert from "node:assert/strict";
import test from "node:test";

const { buildPiChildArgsForTest } = await import("../lib/runner.ts");

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
