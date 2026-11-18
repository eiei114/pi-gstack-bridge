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
  assert.equal(directModelCli("env A=1 bash -lc 'codex exec hello'"), "codex");
  assert.equal(directModelCli("command bash -c 'codex review'"), "codex");
  assert.equal(directModelCli("sh -c \"codex exec hi\""), "codex");
  assert.equal(directModelCli("powershell -Command \"codex exec hi\""), "codex");
  assert.equal(directModelCli("pwsh -c \"gemini --print hi\""), "gemini");
  assert.equal(directModelCli("cmd /c \"claude --print hi\""), "claude");
});

test("detects nested, multi-line, and chained wrapped model CLI invocations", () => {
  assert.equal(directModelCli("bash -lc \"pwsh -c 'codex exec hi'\""), "codex");
  const slash = String.fromCharCode(92);
  for (const innerEscapeCount of [1, 3]) {
    assert.equal(
      directModelCli(`bash -c 'bash -c ${slash}\"echo ${slash.repeat(innerEscapeCount)}\"ok${slash.repeat(innerEscapeCount)}\"; codex${slash}\"'`),
      "codex",
    );
  }
  assert.equal(directModelCli("bash -lc \"echo hi && codex exec hi\""), "codex");
  assert.equal(directModelCli("bash -lc \"echo hi\ncodex exec hi\""), "codex");
  assert.equal(directModelCli("bash -lc \"echo hi\r\ncodex exec hi\""), "codex");
  assert.equal(directModelCli("cmd /c \"echo hi & codex exec hi\""), "codex");
  assert.equal(directModelCli("bash -c 'co'dex"), "codex");
});

test("wrapped shell inspection commands stay allowed", () => {
  assert.equal(directModelCli("bash -lc \"grep -R codex docs\""), undefined);
  assert.equal(directModelCli("bash -lc \"git diff --stat\""), undefined);
  assert.equal(directModelCli("grep -F 'bash -c \\\"codex\\\"' README.md"), undefined);
  assert.equal(directModelCli('This documentation example runs bash -c "codex exec hi"'), undefined);
});

test("classifies common read-only child mutations", () => {
  assert.equal(mutatingShellCommand("git status --short"), undefined);
  assert.equal(mutatingShellCommand("git reset --hard HEAD"), "git mutation");
  assert.equal(mutatingShellCommand("printf test > output.txt"), "shell redirection");
  assert.equal(mutatingShellCommand("npm install"), "package mutation");
});

test("detects git mutations after global options and stash subcommands", () => {
  assert.equal(mutatingShellCommand("git -C sub reset --hard HEAD"), "git mutation");
  assert.equal(mutatingShellCommand("git --git-dir=/repo stash drop"), "git mutation");
  assert.equal(mutatingShellCommand("git --no-pager clean -fd"), "git mutation");
  assert.equal(mutatingShellCommand("git -c core.quotepath=false stash drop"), "git mutation");
  assert.equal(mutatingShellCommand("git -C sub --no-pager reset --hard"), "git mutation");
});

test("detects npm and gh mutations while leaving read-only commands allowed", () => {
  assert.equal(mutatingShellCommand("npm --prefix pkg publish"), "package mutation");
  assert.equal(mutatingShellCommand("npm --prefix=pkg install"), "package mutation");
  assert.equal(mutatingShellCommand("gh pr merge 12"), "GitHub mutation");
  assert.equal(mutatingShellCommand("gh pr close 12"), "GitHub mutation");
  assert.equal(mutatingShellCommand("gh release create v1.2.3"), "GitHub mutation");

  assert.equal(mutatingShellCommand("git status --short"), undefined);
  assert.equal(mutatingShellCommand("git diff --stat"), undefined);
  assert.equal(mutatingShellCommand("git log -1"), undefined);
  assert.equal(mutatingShellCommand("npm run ci"), undefined);
  assert.equal(mutatingShellCommand("npm --prefix pkg run ci"), undefined);
  assert.equal(mutatingShellCommand("gh pr view 12"), undefined);
});

test("does not match mutation words inside option values or inspection text", () => {
  assert.equal(mutatingShellCommand("git -C 'repo reset archive' status"), undefined);
  assert.equal(mutatingShellCommand("git --git-dir='/repo reset' status"), undefined);
  assert.equal(mutatingShellCommand("npm --prefix 'pkg install sandbox' ls"), undefined);
  assert.equal(mutatingShellCommand("grep -F 'gh pr merge' README.txt"), undefined);
});

test("detects mutations at command boundaries in chained shell commands", () => {
  assert.equal(mutatingShellCommand("echo ok && git -C 'sub dir' reset --hard"), "git mutation");
  assert.equal(mutatingShellCommand("cd repo; npm --prefix 'pkg dir' publish"), "package mutation");
  assert.equal(mutatingShellCommand("printf example | gh pr merge 12"), "GitHub mutation");
});
