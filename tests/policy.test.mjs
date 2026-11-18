import assert from "node:assert/strict";
import test from "node:test";

const { directModelCli, directModelCliReason, mutatingShellCommand } = await import("../lib/policy.ts");

test("detects direct Codex invocations and availability probes", () => {
  assert.equal(directModelCli("codex review --all"), "codex");
  assert.equal(directModelCli("codex >/dev/null"), "codex");
  assert.equal(directModelCli("command -v codex >/dev/null"), "codex");
  assert.equal(directModelCli("_gstack_timeout 300 codex exec \"review\""), "codex");
  assert.equal(directModelCli("claude -p \"review\""), "claude");
  assert.match(directModelCliReason("codex exec prompt") ?? "", /gstack_pi_agent/u);
});

test("does not block ordinary repository inspection", () => {
  assert.equal(directModelCli("git diff --stat"), undefined);
  assert.equal(directModelCli("grep -R codex docs"), undefined);
});

test("detects direct model CLI invocations inside shell wrappers", () => {
  assert.equal(directModelCli("bash -lc \"codex exec hello\""), "codex");
  assert.equal(directModelCli("bash -lc 'codex review'"), "codex");
  assert.equal(directModelCli("sh -c \"codex exec hi\""), "codex");
  assert.equal(directModelCli("powershell -Command \"codex exec hi\""), "codex");
  assert.equal(directModelCli("pwsh -c \"gemini --print hi\""), "gemini");
  assert.equal(directModelCli("cmd /c \"claude --print hi\""), "claude");
});

test("detects nested, multi-line, and chained wrapped model CLI invocations", () => {
  assert.equal(directModelCli("bash -lc \"pwsh -c 'codex exec hi'\""), "codex");
  assert.equal(directModelCli("bash -lc \"echo hi && codex exec hi\""), "codex");
  assert.equal(directModelCli("bash -lc \"echo hi\ncodex exec hi\""), "codex");
  assert.equal(directModelCli("bash -lc \"echo hi\r\ncodex exec hi\""), "codex");
  assert.equal(directModelCli("cmd /c \"echo hi & codex exec hi\""), "codex");
});

test("wrapped shell inspection commands stay allowed", () => {
  assert.equal(directModelCli("bash -lc \"grep -R codex docs\""), undefined);
  assert.equal(directModelCli("bash -lc \"git diff --stat\""), undefined);
});

test("classifies common read-only child mutations", () => {
  assert.equal(mutatingShellCommand("git status --short"), undefined);
  assert.equal(mutatingShellCommand("git reset --hard HEAD"), "git mutation");
  assert.equal(mutatingShellCommand("printf test > output.txt"), "shell redirection");
  assert.equal(mutatingShellCommand("npm install"), "package mutation");
});
