import assert from "node:assert/strict";
import test from "node:test";

const { directModelCli, directModelCliReason, mutatingShellCommand } = await import("../lib/policy.ts");

test("detects direct Codex invocations and availability probes", () => {
  assert.equal(directModelCli("codex review --all"), "codex");
  assert.equal(directModelCli("command -v codex >/dev/null"), "codex");
  assert.equal(directModelCli("_gstack_timeout 300 codex exec \"review\""), "codex");
  assert.match(directModelCliReason("codex exec prompt") ?? "", /gstack_pi_agent/u);
});

test("does not block ordinary repository inspection", () => {
  assert.equal(directModelCli("git diff --stat"), undefined);
  assert.equal(directModelCli("grep -R codex docs"), undefined);
});

test("classifies common read-only child mutations", () => {
  assert.equal(mutatingShellCommand("git status --short"), undefined);
  assert.equal(mutatingShellCommand("git reset --hard HEAD"), "git mutation");
  assert.equal(mutatingShellCommand("printf test > output.txt"), "shell redirection");
  assert.equal(mutatingShellCommand("npm install"), "package mutation");
});
