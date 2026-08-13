import assert from "node:assert/strict";
import test from "node:test";

const extension = (await import("../extensions/index.ts")).default;

test("registers Pi-routed gstack tools and commands", () => {
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  const pi = {
    registerTool(definition) {
      tools.set(definition.name, definition);
    },
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
    on(name, handler) {
      handlers.set(name, handler);
    },
    getAllTools() {
      return [{ name: "subagent" }];
    },
  };

  extension(pi);

  for (const name of ["gstack_pi_agent", "gstack_pi_review", "gstack_bridge_status", "Agent", "Task"]) {
    assert.equal(tools.has(name), true, `missing tool ${name}`);
  }
  assert.equal(commands.has("gstack-bridge:status"), true);
  assert.equal(commands.has("gstack-bridge:doctor"), true);
  assert.equal(handlers.has("before_agent_start"), true);
  assert.equal(handlers.has("tool_call"), true);
  assert.equal(handlers.has("user_bash"), true);
});

test("blocks direct model CLI tool and user bash paths", async () => {
  const handlers = new Map();
  const pi = {
    registerTool() {},
    registerCommand() {},
    on(name, handler) {
      handlers.set(name, handler);
    },
    getAllTools() {
      return [];
    },
  };

  extension(pi);

  const toolResult = await handlers.get("tool_call")({
    toolName: "bash",
    input: { command: "codex review --all" },
  });
  assert.equal(toolResult.block, true);
  assert.match(toolResult.reason, /Direct codex CLI execution is disabled/u);

  const userResult = await handlers.get("user_bash")({ command: "codex review --all" });
  assert.equal(userResult.result.exitCode, 126);
  assert.match(userResult.result.output, /gstack_pi_review/u);
});
