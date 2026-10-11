import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertSemanticAssertions, assertToolResult } from "../scripts/pi-sdk-smoke.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

test("smoke assertion accepts an observed successful bridge response", () => {
  const events = [{
    type: "tool_execution_end",
    toolName: "gstack_pi_agent",
    isError: false,
    result: {
      content: [{ type: "text", text: "actual child output: PI_GSTACK_SMOKE_CHILD_OK" }],
      details: { exitCode: 0 },
    },
  }];
  assert.equal(assertToolResult(events, "gstack_pi_agent", "PI_GSTACK_SMOKE_CHILD_OK").event.isError, false);
});

test("smoke assertion rejects a deliberately missing feature response", () => {
  const events = [{
    type: "tool_execution_end",
    toolName: "gstack_pi_agent",
    isError: false,
    result: { content: [{ type: "text", text: "actual child output without marker" }], details: { exitCode: 0 } },
  }];
  assert.throws(() => assertToolResult(events, "gstack_pi_agent", "PI_GSTACK_SMOKE_CHILD_OK"), /did not contain/u);
});

test("smoke assertion rejects a deliberately absent reload semantic result", () => {
  const assertions = [{ id: "reloaded_extension_registered", expected: "registered", observed: "missing", passed: false }];
  assert.throws(() => assertSemanticAssertions(assertions, ["reloaded_extension_registered", "reloaded_feature_response"]), /did not pass/u);
});

test("committed smoke report follows the required Pi behavior contract", async () => {
  const report = JSON.parse(await readFile(path.join(root, "docs", "verification", "pi-sdk-smoke.json"), "utf8"));
  assert.equal(report.schema_version, 1);
  assert.equal(report.verification_contract, "pi-sdk-behavior-v2");
  assert.equal(report.unhandled_errors, 0);
  assert.equal(report.extension_load_errors, 0);
  for (const name of ["pi-agent-core", "pi-ai", "pi-coding-agent", "pi-tui"]) {
    assert.equal(report.sdk_versions[`@earendil-works/${name}`], "1.1.0");
  }
  assert.deepEqual(report.cases.map((entry) => entry.name), ["extension_load", "happy_path", "error_path", "reload_cleanup", "host_shell"]);
  for (const entry of report.cases) {
    assert.equal(entry.exit_code, 0, `${entry.name} did not record a passing exit code`);
    assert.equal(entry.passed, true, `${entry.name} did not pass`);
    assert.ok(entry.command.includes("smoke:pi"), `${entry.name} has no reproducible command`);
    const evidencePath = path.resolve(root, entry.evidence);
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    assert.equal(evidence.case, entry.name);
    assertSemanticAssertions(entry.assertions, {
      extension_load: ["extension_registered"],
      happy_path: ["feature_response"],
      error_path: ["handled_error"],
      reload_cleanup: ["reloaded_extension_registered", "reloaded_feature_response", "clean_shutdown"],
      host_shell: ["native_shell_boundary"],
    }[entry.name]);
  }
});
