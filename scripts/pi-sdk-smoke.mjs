import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PI_CLI = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const REPORT_PATH = path.join(ROOT, "docs", "verification", "pi-sdk-smoke.json");
const ARTIFACT_DIR = path.join(ROOT, "docs", "verification", "artifacts", "pi-sdk-smoke");
const SHORT_TIMEOUT_MS = 15_000;
// Windows Actions showed the live Pi process can take longer than the normal request deadline to emit its first state response.
const STARTUP_TIMEOUT_MS = 30_000;
const TOOL_TIMEOUT_MS = 25_000;
const CLEANUP_TIMEOUT_MS = 1_000;
const SDK_VERSIONS = {
  "@earendil-works/pi-agent-core": "1.1.0",
  "@earendil-works/pi-ai": "1.1.0",
  "@earendil-works/pi-coding-agent": "1.1.0",
  "@earendil-works/pi-tui": "1.1.0",
};
const CASE_NAMES = ["extension_load", "happy_path", "error_path", "reload_cleanup", "host_shell"];
const SEMANTIC_IDS = {
  extension_load: ["extension_registered"],
  happy_path: ["feature_response"],
  error_path: ["handled_error"],
  reload_cleanup: ["reloaded_extension_registered", "reloaded_feature_response", "clean_shutdown"],
  host_shell: ["native_shell_boundary"],
};

function rpcEventText(event) {
  return (event?.result?.content ?? [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

export function assertToolResult(events, toolName, expectedText, { childExitCode = true } = {}) {
  const event = events.find((entry) => entry?.type === "tool_execution_end" && entry.toolName === toolName);
  assert.ok(event, `Pi did not execute ${toolName}`);
  assert.equal(event.isError, false, `${toolName} returned an unhandled tool error`);
  const text = rpcEventText(event);
  assert.ok(text.includes(expectedText), `${toolName} result did not contain ${JSON.stringify(expectedText)}; got ${JSON.stringify(text)}`);
  if (childExitCode) assert.equal(event.result?.details?.exitCode, 0, `${toolName} child Pi did not exit successfully`);
  return { event, text };
}

export function assertSemanticAssertions(assertions, requiredIds) {
  const byId = new Map(assertions.map((assertion) => [assertion.id, assertion]));
  for (const id of requiredIds) {
    const assertion = byId.get(id);
    assert.ok(assertion, `missing semantic assertion ${id}`);
    assert.equal(assertion.passed, true, `semantic assertion ${id} did not pass`);
    assert.ok(assertion.expected, `semantic assertion ${id} has no expected behavior`);
    assert.ok(assertion.observed, `semantic assertion ${id} has no observed result`);
  }
}

function flattenMessage(message) {
  if (typeof message === "string") return message;
  if (Array.isArray(message)) {
    return message.map((part) => part?.type === "text" ? part.text ?? "" : "").join("\n");
  }
  return "";
}

function sseChunk(id, model, delta, finishReason = null) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function selectResponse(scenario, messages) {
  const allText = messages.map((message) => flattenMessage(message.content)).join("\n");
  const toolTexts = messages.filter((message) => message.role === "tool").map((message) => flattenMessage(message.content));
  const toolResult = toolTexts.join("\n");
  if (allText.includes("SMOKE_CHILD_HAPPY_OK")) return { kind: "text", text: "PI_GSTACK_SMOKE_CHILD_OK" };
  if (allText.includes("SMOKE_CHILD_RELOADED_OK")) return { kind: "text", text: "PI_GSTACK_SMOKE_RELOADED_OK" };
  const toolCall = (task) => ({
    kind: "tool",
    name: "gstack_pi_agent",
    arguments: { task, timeoutMs: 12_000, readOnly: true, tools: "read,bash,grep,find,ls" },
  });

  if (scenario === "happy_path" && allText.includes("SMOKE_HAPPY_PATH")) {
    if (toolResult) return { kind: "text", text: "PARENT_OBSERVED_BRIDGE_CHILD_OK" };
    return toolCall("SMOKE_CHILD_HAPPY_OK");
  }
  if (scenario === "error_path" && allText.includes("SMOKE_ERROR_PATH")) {
    if (toolResult) return { kind: "text", text: "PARENT_OBSERVED_HANDLED_ERROR" };
    return toolCall("");
  }
  if ((scenario === "reload_cleanup" || scenario === "host_shell") && allText.includes("SMOKE_RELOADED_PATH")) {
    if (toolResult) return { kind: "text", text: "PARENT_OBSERVED_RELOADED_CHILD_OK" };
    return toolCall("SMOKE_CHILD_RELOADED_OK");
  }
  return { kind: "unexpected", text: `Unexpected ${scenario} model request` };
}

async function startOfflineModel(scenario) {
  const requests = [];
  const failures = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      failures.push(`invalid model request JSON: ${error.message}`);
      response.writeHead(400).end("invalid json");
      return;
    }
    const choice = selectResponse(scenario, Array.isArray(body.messages) ? body.messages : []);
    requests.push({ path: request.url, model: body.model, choice: choice.kind });
    if (choice.kind === "unexpected") {
      failures.push(choice.text);
      response.writeHead(500).end(choice.text);
      return;
    }
    const completionId = `pi-gstack-smoke-${requests.length}`;
    if (!body.stream) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: completionId,
        object: "chat.completion",
        created: 0,
        model: body.model,
        choices: [{
          index: 0,
          message: choice.kind === "tool"
            ? { role: "assistant", content: null, tool_calls: [{ id: `call-${completionId}`, type: "function", function: { name: choice.name, arguments: JSON.stringify(choice.arguments) } }] }
            : { role: "assistant", content: choice.text },
          finish_reason: choice.kind === "tool" ? "tool_calls" : "stop",
        }],
      }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    response.write(sseChunk(completionId, body.model, { role: "assistant" }));
    if (choice.kind === "tool") {
      response.write(sseChunk(completionId, body.model, {
        tool_calls: [{
          index: 0,
          id: `call-${completionId}`,
          type: "function",
          function: { name: choice.name, arguments: JSON.stringify(choice.arguments) },
        }],
      }));
      response.write(sseChunk(completionId, body.model, {}, "tool_calls"));
    } else {
      response.write(sseChunk(completionId, body.model, { content: choice.text }));
      response.write(sseChunk(completionId, body.model, {}, "stop"));
    }
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    failures,
    async close() {
      let timer;
      const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections?.();
      try {
        await Promise.race([
          closed,
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Offline model server did not close within the cleanup deadline")), CLEANUP_TIMEOUT_MS); }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function errorLike(text) {
  return /uncaught exception|unhandled rejection|unhandled error|shutdown error|error during shutdown/iu.test(text);
}

export function createHostHarness(child, scenario) {
  const records = [];
  const protocolErrors = [];
  let stderr = "";
  let buffer = "";
  const waiters = new Set();
  const closePromise = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const record = JSON.parse(line);
        records.push(record);
        for (const waiter of [...waiters]) {
          if (waiter.predicate(record)) {
            waiters.delete(waiter);
            clearTimeout(waiter.timer);
            waiter.resolve(record);
          }
        }
      } catch {
        protocolErrors.push(line);
      }
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  function waitFor(predicate, timeoutMs, label) {
    const found = records.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        waiters.delete(waiter);
        clearTimeout(timer);
        callback(value);
      };
      const waiter = {
        predicate,
        resolve: (value) => finish(resolve, value),
        timer: undefined,
      };
      waiters.add(waiter);
      timer = setTimeout(() => finish(
        reject,
        new Error(`Pi RPC deadline (${timeoutMs}ms) while waiting for ${label}; pid=${child.pid} exit=${child.exitCode} signal=${child.signalCode}\nstderr:\n${stderr}`),
      ), timeoutMs);
      waiter.timer = timer;
      closePromise.then(({ code, signal }) => finish(
        reject,
        new Error(`Pi RPC process exited before ${label}; exit=${code} signal=${signal}\nstderr:\n${stderr}`),
      ));
    });
  }

  let requestNumber = 0;
  async function request(type, fields = {}, timeoutMs = SHORT_TIMEOUT_MS) {
    const id = `smoke-${scenario}-${++requestNumber}`;
    const responsePromise = waitFor((record) => record.type === "response" && record.id === id, timeoutMs, `${type} response`);
    child.stdin.write(`${JSON.stringify({ type, id, ...fields })}\n`);
    const record = await responsePromise;
    assert.equal(record.success, true, `${type} RPC failed: ${record.error ?? "unknown"}`);
    return record.data;
  }

  return {
    child,
    records,
    get stderr() { return stderr; },
    protocolErrors,
    waitFor,
    request,
    async prompt(message) {
      const agentEnd = waitFor((record) => record.type === "agent_end", TOOL_TIMEOUT_MS, "agent_end after prompt");
      await request("prompt", { message }, SHORT_TIMEOUT_MS);
      await agentEnd;
      return request("get_last_assistant_text", {}, SHORT_TIMEOUT_MS);
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return closePromise;
      child.stdin.end();
      let timer;
      const closed = await Promise.race([
        closePromise,
        new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), CLEANUP_TIMEOUT_MS); }),
      ]);
      clearTimeout(timer);
      if (!closed) {
        await killOwnedProcessTree(child);
        throw new Error(`Pi RPC process ${child.pid} did not exit cleanly within ${CLEANUP_TIMEOUT_MS}ms`);
      }
      return closed;
    },
    async forceCleanup() {
      if (child.exitCode === null && child.signalCode === null) {
        await killOwnedProcessTree(child);
        await Promise.race([closePromise, new Promise((resolve) => setTimeout(resolve, CLEANUP_TIMEOUT_MS))]);
      }
    },
  };
}

async function killOwnedProcessTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: CLEANUP_TIMEOUT_MS, stdio: "ignore" });
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} }
  }
}

async function startHost(tempRoot, model, scenario) {
  const agentDir = path.join(tempRoot, `agent-${scenario}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  const runDir = path.join(tempRoot, "bridge-runs");
  await mkdir(agentDir, { recursive: true });
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "pi-gstack-smoke": {
        name: "Pi SDK smoke (offline)",
        api: "openai-completions",
        baseUrl: model.baseUrl,
        apiKey: "offline-smoke-only",
        models: [{
          id: "smoke-model",
          name: "Deterministic offline smoke model",
          api: "openai-completions",
          baseUrl: model.baseUrl,
          reasoning: false,
          input: ["text"],
          contextWindow: 32768,
          maxTokens: 256,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }],
      },
    },
  }, null, 2), "utf8");

  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: path.join(tempRoot, "sessions"),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    GSTACK_PI_BRIDGE_RUN_DIR: runDir,
  };
  for (const key of Object.keys(env)) {
    if (/^(?:OPENAI|ANTHROPIC|GEMINI|GOOGLE|AZURE_OPENAI|DEEPSEEK|GROQ|MISTRAL|OPENROUTER|XAI|NVIDIA|CEREBRAS|TOGETHER|FIREWORKS|MINIMAX|MOONSHOT|OPENCODE|KIMI|META|ZAI|QWEN|CLOUDFLARE)_.*(?:API_KEY|TOKEN)$/iu.test(key)) delete env[key];
  }
  const child = spawn(process.execPath, [
    PI_CLI,
    "--mode", "rpc",
    "--no-session",
    "--no-skills",
    "--no-prompt-templates",
    "--no-mcp",
    "--no-themes",
    "--no-context-files",
    "--offline",
    "--no-extensions",
    "--extension", path.join(ROOT, "extensions", "index.ts"),
    "--provider", "pi-gstack-smoke",
    "--model", "smoke-model",
    "--approve",
  ], {
    cwd: ROOT,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  const harness = createHostHarness(child, scenario);
  return harness;
}

function errorsForHarness(harness) {
  const loadErrors = harness.records.filter((record) => record.type === "extension_error");
  const unhandled = errorLike(harness.stderr) ? [harness.stderr.match(/[^\r\n]*(?:uncaught exception|unhandled rejection|unhandled error|shutdown error|error during shutdown)[^\r\n]*/iu)?.[0] ?? "Pi process emitted an unhandled/shutdown error"] : [];
  return { loadErrors, unhandled };
}

async function startCase(scenario) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-gstack-bridge-smoke-"));
  const model = await startOfflineModel(scenario);
  const hosts = [];
  const processResults = [];
  const assertions = [];
  const observed = {};
  let errors = { extension_load_errors: 0, unhandled_errors: 0 };
  const start = async () => {
    const harness = await startHost(tempRoot, model, scenario);
    hosts.push(harness);
    const state = await harness.request("get_state", {}, STARTUP_TIMEOUT_MS);
    assert.equal(state.model?.provider, "pi-gstack-smoke", "Pi did not use the isolated offline model");
    assert.equal(state.model?.id, "smoke-model");
    return harness;
  };
  const checkNoErrors = (harness) => {
    const found = errorsForHarness(harness);
    errors.extension_load_errors += found.loadErrors.length;
    errors.unhandled_errors += found.unhandled.length;
    assert.equal(found.loadErrors.length, 0, `Pi reported extension load/runtime errors: ${JSON.stringify(found.loadErrors)}`);
    assert.equal(found.unhandled.length, 0, `Pi emitted unhandled or shutdown errors: ${found.unhandled.join("; ")}`);
    assert.deepEqual(harness.protocolErrors, [], `Pi emitted non-JSON stdout outside the RPC protocol: ${harness.protocolErrors.join(" | ")}`);
  };
  const cleanStop = async (harness) => {
    const result = await harness.stop();
    processResults.push(result.code);
    assert.equal(result.code, 0, `Pi RPC exited with ${result.code ?? result.signal}`);
    assert.equal(result.signal, null, "Pi RPC was terminated instead of shutting down cleanly");
    checkNoErrors(harness);
    return result;
  };
  try {
    if (scenario === "extension_load") {
      const harness = await start();
      const result = await harness.request("get_commands");
      const names = result.commands.map((command) => command.name);
      assert.ok(names.includes("gstack-bridge:status"), `bridge status command was not registered: ${names.join(", ")}`);
      assert.ok(names.includes("gstack-bridge:doctor"), `bridge doctor command was not registered: ${names.join(", ")}`);
      observed.registeredCommands = names.filter((name) => name.startsWith("gstack-bridge:"));
      assertions.push({
        id: "extension_registered",
        expected: "Pi 1.1.0 loads the actual package extension and registers gstack-bridge:status and gstack-bridge:doctor.",
        observed: `get_commands returned ${observed.registeredCommands.join(" and ")} from a live Pi RPC host.`,
        passed: true,
      });
      await cleanStop(harness);
    } else if (scenario === "happy_path" || scenario === "error_path" || scenario === "host_shell") {
      const harness = await start();
      const marker = scenario === "happy_path" ? "SMOKE_HAPPY_PATH" : scenario === "error_path" ? "SMOKE_ERROR_PATH" : "SMOKE_RELOADED_PATH";
      observed.parentResponse = (await harness.prompt(marker)).text;
      const expectedToolText = scenario === "happy_path"
        ? "PI_GSTACK_SMOKE_CHILD_OK"
        : scenario === "error_path" ? "No child task was provided." : "PI_GSTACK_SMOKE_RELOADED_OK";
      const result = assertToolResult(harness.records, "gstack_pi_agent", expectedToolText, { childExitCode: scenario !== "error_path" });
      observed.toolResponse = expectedToolText;
      if (scenario === "happy_path") {
        assert.ok(observed.parentResponse.includes("PARENT_OBSERVED_BRIDGE_CHILD_OK"), `Pi parent did not consume the child result: ${observed.parentResponse}`);
        assertions.push({
          id: "feature_response",
          expected: "The registered gstack_pi_agent tool launches a real Pi child; its result is returned as a handled tool response and observed by the parent model.",
          observed: `The tool result contained ${expectedToolText}; child exit_code=${result.event.result.details.exitCode}; parent response contained PARENT_OBSERVED_BRIDGE_CHILD_OK.`,
          passed: true,
        });
      } else if (scenario === "error_path") {
        assert.ok(observed.parentResponse.includes("PARENT_OBSERVED_HANDLED_ERROR"), `Pi parent did not observe handled empty-task result: ${observed.parentResponse}`);
        assertions.push({
          id: "handled_error",
          expected: "An empty task is handled by the real extension as a non-error tool result; Pi remains responsive and the parent observes that result.",
          observed: `tool_execution_end isError=false with ${JSON.stringify(expectedToolText)}; parent response contained PARENT_OBSERVED_HANDLED_ERROR.`,
          passed: true,
        });
      } else {
        const launchPlan = result.event.result.details.launchPlan;
        assert.ok(launchPlan, "actual bridge child result did not expose its launch plan");
        const sameExecutable = process.platform === "win32"
          ? String(launchPlan.command).toLowerCase() === process.execPath.toLowerCase()
          : launchPlan.command === process.execPath;
        assert.equal(sameExecutable, true, `bridge did not execute the pinned Pi CLI through Node: ${JSON.stringify(launchPlan)}`);
        assert.ok(launchPlan.argsPrefix.some((argument) => path.resolve(argument) === path.resolve(PI_CLI)), `launch plan did not select installed Pi 1.1.0 CLI: ${JSON.stringify(launchPlan)}`);
        assert.equal(launchPlan.shell, false, "bridge used a shell or Windows .cmd wrapper instead of native Node process launch");
        observed.platform = process.platform;
        observed.launchCommand = path.basename(launchPlan.command);
        observed.cli = path.relative(ROOT, launchPlan.argsPrefix.find((argument) => path.resolve(argument) === path.resolve(PI_CLI))).replaceAll("\\", "/");
        observed.shell = launchPlan.shell;
        observed.childResponse = expectedToolText;
        assertions.push({
          id: "native_shell_boundary",
          expected: "The actual bridge child executes the installed Pi 1.1.0 CLI through process.execPath with shell=false and returns a handled feature response; on Windows this bypasses pi.cmd.",
          observed: `${process.platform}: executable=${observed.launchCommand}, cli=${observed.cli}, shell=${launchPlan.shell}; child response contained ${expectedToolText}.`,
          passed: true,
        });
      }
      if (model.failures.length) throw new Error(model.failures.join("; "));
      assert.ok(model.requests.length >= (scenario === "error_path" ? 1 : 2), `offline model received too few actual Pi requests: ${model.requests.length}`);
      observed.modelRequests = model.requests.length;
      await cleanStop(harness);
    } else if (scenario === "reload_cleanup") {
      const first = await start();
      const initial = await first.request("get_commands");
      assert.ok(initial.commands.some((command) => command.name === "gstack-bridge:status"), "first Pi process did not load the extension");
      const firstExit = await cleanStop(first);
      const second = await start();
      const afterReload = await second.request("get_commands");
      assert.ok(afterReload.commands.some((command) => command.name === "gstack-bridge:status"), "second Pi process did not reload the extension");
      observed.secondProcessCommand = "gstack-bridge:status";
      const commands = afterReload.commands.map((command) => command.name).filter((name) => name.startsWith("gstack-bridge:"));
      assertions.push({
        id: "reloaded_extension_registered",
        expected: "After clean shutdown, a second actual Pi process reloads the extension and registers its bridge command.",
        observed: `Second Pi process get_commands returned ${commands.join(" and ")}.`,
        passed: true,
      });
      observed.secondProcessResponse = (await second.prompt("SMOKE_RELOADED_PATH")).text;
      const result = assertToolResult(second.records, "gstack_pi_agent", "PI_GSTACK_SMOKE_RELOADED_OK");
      assert.ok(observed.secondProcessResponse.includes("PARENT_OBSERVED_RELOADED_CHILD_OK"), `second Pi parent did not observe reloaded feature result: ${observed.secondProcessResponse}`);
      assertions.push({
        id: "reloaded_feature_response",
        expected: "The reloaded extension in the second actual Pi process executes gstack_pi_agent, receives a successful actual child Pi response, and returns it to the parent.",
        observed: `Second process tool result contained PI_GSTACK_SMOKE_RELOADED_OK, child exit_code=${result.event.result.details.exitCode}; parent response contained PARENT_OBSERVED_RELOADED_CHILD_OK.`,
        passed: true,
      });
      const secondExit = await cleanStop(second);
      observed.processExitCodes = [firstExit.code, secondExit.code];
      assertions.push({
        id: "clean_shutdown",
        expected: "Both sequential Pi RPC processes exit naturally with status 0 after stdin close; neither is killed to satisfy the check and no extension/unhandled/shutdown errors are observed.",
        observed: `First process exit=${firstExit.code}; second process exit=${secondExit.code}; extension load errors=${errors.extension_load_errors}; unhandled/shutdown errors=${errors.unhandled_errors}.`,
        passed: true,
      });
    }
    if (model.failures.length) throw new Error(model.failures.join("; "));
    assert.equal(errors.extension_load_errors, 0);
    assert.equal(errors.unhandled_errors, 0);
    assertSemanticAssertions(assertions, SEMANTIC_IDS[scenario]);
    return {
      name: scenario,
      command: `npm run smoke:pi -- --case ${scenario}`,
      exit_code: 0,
      passed: true,
      evidence: `docs/verification/artifacts/pi-sdk-smoke/${scenario}.json`,
      assertions,
      observation: observed,
      process_exit_codes: processResults,
      extension_load_errors: errors.extension_load_errors,
      unhandled_errors: errors.unhandled_errors,
      platform: process.platform,
    };
  } finally {
    for (const harness of hosts) await harness.forceCleanup();
    await model.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function assertPinnedDependencies() {
  const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(path.join(ROOT, "package-lock.json"), "utf8"));
  const installed = JSON.parse(await readFile(path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "utf8"));
  assert.deepEqual(installed.version, SDK_VERSIONS["@earendil-works/pi-coding-agent"], "smoke must execute the exact frozen Pi CLI version");
  for (const [name, version] of Object.entries(SDK_VERSIONS)) {
    assert.equal(pkg.devDependencies[name], version, `${name} must be an exact devDependency pin`);
    assert.equal(lock.packages[""].devDependencies[name], version, `${name} lock root does not match the frozen pin`);
    assert.equal(lock.packages[`node_modules/${name}`].version, version, `${name} installed lock entry is not frozen`);
  }
  return installed.version;
}

async function recordResults(sdkVersion, cases) {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  for (const result of cases) {
    const artifact = {
      schema_version: 1,
      case: result.name,
      command: result.command,
      sdk_version: sdkVersion,
      platform: result.platform,
      process_exit_codes: result.process_exit_codes,
      extension_load_errors: result.extension_load_errors,
      unhandled_errors: result.unhandled_errors,
      assertions: result.assertions,
      observation: result.observation,
    };
    await writeFile(path.join(ARTIFACT_DIR, `${result.name}.json`), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  }
  const report = {
    schema_version: 1,
    verification_contract: "pi-sdk-behavior-v2",
    sdk_versions: SDK_VERSIONS,
    unhandled_errors: cases.reduce((sum, result) => sum + result.unhandled_errors, 0),
    extension_load_errors: cases.reduce((sum, result) => sum + result.extension_load_errors, 0),
    cases: cases.map(({ name, command, exit_code, passed, evidence, assertions }) => ({ name, command, exit_code, passed, evidence, assertions })),
  };
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

async function main(args) {
  const record = args.includes("--record");
  const caseIndex = args.indexOf("--case");
  const selectedCase = caseIndex >= 0 ? args[caseIndex + 1] : undefined;
  if (record && selectedCase) throw new Error("--record requires running all five cases; omit --case");
  if (selectedCase && !CASE_NAMES.includes(selectedCase)) throw new Error(`Unknown smoke case ${selectedCase}; expected one of ${CASE_NAMES.join(", ")}`);
  const sdkVersion = await assertPinnedDependencies();
  const selected = selectedCase ? [selectedCase] : CASE_NAMES;
  const cases = [];
  for (const name of selected) {
    cases.push(await startCase(name));
    process.stdout.write(`PASS ${name}\n`);
  }
  if (record) {
    const report = await recordResults(sdkVersion, cases);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const result of cases) assertSemanticAssertions(result.assertions, SEMANTIC_IDS[result.name]);
    process.stdout.write(`${JSON.stringify({ sdk_version: sdkVersion, cases: cases.map(({ name, passed, process_exit_codes }) => ({ name, passed, process_exit_codes })) }, null, 2)}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  });
}
