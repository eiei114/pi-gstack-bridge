import { execFile, spawn as nodeSpawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { applyPiLaunchPlan, resolvePiLaunchPlan } from "./pi-launcher.ts";
import type {
  GstackBridgeContext,
  GstackBridgeMode,
  GstackBridgeRequest,
  GstackBridgeRunDetails,
  GstackBridgeRunResult,
  PiLaunchPlan,
} from "./types.ts";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_OUTPUT_CHARS = 50 * 1024;
const MAX_CONTEXT_CHARS = 120 * 1024;
const DEFAULT_TOOLS = "read,bash,grep,find,ls";

export interface ChildSpawn {
  stdout?: NodeJS.ReadableStream;
  stderr?: NodeJS.ReadableStream;
  pid?: number;
  on(event: string, listener: (...args: any[]) => void): ChildSpawn;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type ChildSpawner = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    shell: boolean;
    stdio: ["ignore", "pipe", "pipe"];
    detached: boolean;
  },
) => ChildSpawn;

export interface RunPiChildOptions {
  spawn?: ChildSpawner;
  launchPlan?: PiLaunchPlan;
  runRoot?: string;
  now?: () => Date;
}

function clampTimeout(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.max(1000, Math.min(MAX_TIMEOUT_MS, Math.trunc(value as number)));
}

function clampOutput(value: string, limit = MAX_OUTPUT_CHARS): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n\n[output truncated]`;
}

function modelSpec(model: string | undefined, parentModel: string | undefined): string | undefined {
  const value = model?.trim() || parentModel?.trim() || process.env.GSTACK_PI_BRIDGE_MODEL?.trim();
  if (!value) return undefined;
  if (value.includes("/")) return value;
  const provider = parentModel?.split("/", 1)[0] || process.env.GSTACK_PI_BRIDGE_PROVIDER?.trim();
  return provider ? `${provider}/${value}` : value;
}

function modeInstructions(mode: GstackBridgeMode): string {
  switch (mode) {
    case "review":
      return "Review the requested change independently. Prioritize concrete production failures, security issues, regressions, and missing tests.";
    case "challenge":
      return "Act as an adversarial reviewer. Try to break the proposal or implementation. Report only actionable problems and their evidence.";
    case "consult":
      return "Provide an independent second opinion. State assumptions, trade-offs, and a clear recommendation.";
    case "design":
      return "Evaluate the design and propose a coherent, opinionated direction grounded in the repository and task context.";
    case "agent":
    default:
      return "Perform the focused specialist task for the parent gstack workflow.";
  }
}

function buildSystemPrompt(request: GstackBridgeRequest, tools: string, readOnly: boolean): string {
  const mode = request.mode ?? "agent";
  return [
    "You are a focused child Pi agent launched by pi-gstack-bridge.",
    "",
    modeInstructions(mode),
    "",
    "Execution contract:",
    "- Work independently. Do not assume the parent agent is correct.",
    "- Use repository evidence. Identify exact files, symbols, commands, or missing evidence.",
    "- Never invoke codex, claude, gemini, or any other AI CLI. You are already running inside Pi.",
    readOnly
      ? "- This is a read-only run. Do not edit, create, delete, stage, commit, push, install, or otherwise mutate files. Bash is limited to inspection commands."
      : "- Only modify files when the task explicitly requires it and the enabled tools permit it.",
    "- Do not call Agent, Task, gstack_pi_agent, or gstack_pi_review recursively.",
    "- Return only a concise markdown report usable by the parent agent.",
    "",
    `Allowed tools: ${tools}`,
    `Mode: ${mode}`,
  ].join("\n");
}

function buildTaskPrompt(request: GstackBridgeRequest): string {
  const mode = request.mode ?? "agent";
  return [
    "# gstack Pi child task",
    "",
    `Mode: ${mode}`,
    "",
    "## Task",
    "",
    request.task.trim(),
    "",
    "## Required output",
    "",
    "## Verdict",
    "One-sentence bottom line.",
    "",
    "## Findings",
    "Bulleted findings ordered by severity or importance. Include file and line references when possible.",
    "",
    "## Evidence",
    "Commands, files, observations, and assumptions supporting the findings.",
    "",
    "## Risks",
    "Uncertainty, missing context, and likely failure modes.",
    "",
    "## Recommended action",
    "Concrete next step for the parent agent.",
  ].join("\n");
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", args, { cwd, timeout: 10_000, maxBuffer: 256 * 1024 });
    return clampOutput(`${result.stdout}\n${result.stderr}`.trim(), 16_000);
  } catch (error) {
    const output = error as { stdout?: string; stderr?: string };
    return clampOutput(`${output.stdout ?? ""}\n${output.stderr ?? ""}`.trim(), 16_000);
  }
}

async function buildContextFileContent(context: GstackBridgeContext, request: GstackBridgeRequest, tools: string): Promise<string> {
  const [branch, status, diffStat] = await Promise.all([
    runGit(context.cwd, ["branch", "--show-current"]),
    runGit(context.cwd, ["status", "--short"]),
    runGit(context.cwd, ["diff", "--stat"]),
  ]);
  return clampOutput([
    "# gstack Pi child context",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Working directory: ${context.cwd}`,
    `Requested mode: ${request.mode ?? "agent"}`,
    `Parent model: ${context.parentModel ?? "default"}`,
    `Tool allowlist: ${tools}`,
    "",
    "## Git state",
    "",
    `Branch: ${branch || "unknown"}`,
    "",
    "Status:",
    "```text",
    status || "clean or unavailable",
    "```",
    "",
    "Diff stat:",
    "```text",
    diffStat || "none or unavailable",
    "```",
    "",
    "## Recent parent user messages",
    "",
    ...(context.recentUserMessages?.length
      ? context.recentUserMessages.map((message, index) => `${index + 1}. ${message}`)
      : ["No recent parent messages were available."]),
    "",
    "Treat this as a fresh, independent pass.",
  ].join("\n"), MAX_CONTEXT_CHARS);
}

function buildChildArgs(
  request: GstackBridgeRequest,
  files: { contextFile: string; taskFile: string; systemFile: string },
  model: string | undefined,
  tools: string,
): string[] {
  const args = [
    "--no-session",
    "--no-skills",
    "--no-prompt-templates",
    "--append-system-prompt",
    files.systemFile,
  ];
  if (model) args.push("--model", model);
  if (request.thinking) args.push("--thinking", request.thinking);
  if (tools && tools !== "all") args.push("--tools", tools);
  args.push(
    "-p",
    `@${files.contextFile}`,
    `@${files.taskFile}`,
    "Complete the attached gstack child task and return only the requested markdown report.",
  );
  return args;
}

function appendStream(stream: NodeJS.ReadableStream | undefined, target: { value: string }): void {
  stream?.on("data", (chunk: Buffer | string) => {
    target.value = `${target.value}${chunk.toString()}`;
    if (target.value.length > MAX_OUTPUT_CHARS * 2) target.value = target.value.slice(-MAX_OUTPUT_CHARS * 2);
  });
}

function terminateChild(child: ChildSpawn): void {
  try {
    child.kill("SIGTERM");
  } catch {
    // Best effort. The close event still determines the result.
  }
}

function defaultSpawner(command: string, args: string[], options: Parameters<ChildSpawner>[2]): ChildSpawn {
  return nodeSpawn(command, args, options) as unknown as ChildSpawn;
}

export async function runPiChild(
  request: GstackBridgeRequest,
  context: GstackBridgeContext,
  signal?: AbortSignal,
  onUpdate?: (text: string) => void,
  options: RunPiChildOptions = {},
): Promise<GstackBridgeRunResult> {
  const cwd = request.cwd?.trim() || context.cwd;
  const mode = request.mode ?? "agent";
  const readOnly = request.readOnly ?? true;
  const tools = request.tools?.trim() || DEFAULT_TOOLS;
  const timeoutMs = clampTimeout(request.timeoutMs);
  const model = modelSpec(request.model, context.parentModel);
  const plan = options.launchPlan ?? resolvePiLaunchPlan();
  const root = options.runRoot ?? process.env.GSTACK_PI_BRIDGE_RUN_DIR ?? path.join(homedir(), ".gstack", "pi-bridge-runs");
  const now = options.now ?? (() => new Date());
  const runId = `${now().toISOString().replaceAll(":", "-").replaceAll(".", "-")}-${Math.random().toString(36).slice(2, 8)}`;
  const runDir = path.join(root, runId);
  await fs.mkdir(runDir, { recursive: true });

  const contextFile = path.join(runDir, "context.md");
  const taskFile = path.join(runDir, "task.md");
  const systemFile = path.join(runDir, "system.md");
  const outputFile = path.join(runDir, "output.txt");
  await Promise.all([
    fs.writeFile(contextFile, await buildContextFileContent(context, request, tools), "utf8"),
    fs.writeFile(taskFile, buildTaskPrompt(request), "utf8"),
    fs.writeFile(systemFile, buildSystemPrompt(request, tools, readOnly), "utf8"),
  ]);

  const details: GstackBridgeRunDetails = {
    runtime: "pi-gstack-bridge",
    mode,
    cwd,
    model,
    thinking: request.thinking,
    tools,
    readOnly,
    timeoutMs,
    runDir,
    contextFile,
    taskFile,
    systemFile,
    outputFile,
    launchPlan: plan,
  };

  if (plan.confidence === "missing") {
    const text = `Pi child unavailable.\n\n${plan.warnings.join("\n")}`;
    await fs.writeFile(outputFile, text, "utf8");
    return { text, details };
  }

  const args = buildChildArgs(request, { contextFile, taskFile, systemFile }, model, tools);
  const env = {
    ...process.env,
    ...plan.envPatch,
    PI_GSTACK_AGENT_CHILD: "1",
    PI_GSTACK_BRIDGE_CHILD: "1",
    PI_GSTACK_BRIDGE_READ_ONLY: readOnly ? "1" : "0",
    PI_SKIP_VERSION_CHECK: "1",
  };
  applyPiLaunchPlan(plan, env);

  onUpdate?.(`Starting Pi child (${mode}, ${model ?? "default model"})...`);
  const stdout = { value: "" };
  const stderr = { value: "" };
  const spawn = options.spawn ?? defaultSpawner;

  let child: ChildSpawn;
  try {
    child = spawn(plan.command, [...plan.argsPrefix, ...args], {
      cwd,
      env,
      shell: plan.shell,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const text = `Pi child spawn failed: ${error instanceof Error ? error.message : String(error)}`;
    await fs.writeFile(outputFile, text, "utf8");
    return { text, details };
  }

  appendStream(child.stdout, stdout);
  appendStream(child.stderr, stderr);

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      terminateChild(child);
      finish(null, "SIGTERM");
    };
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (code: number | null, childSignal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ code, signal: childSignal });
    };
    timer = setTimeout(() => {
      terminateChild(child);
      finish(null, "SIGTERM");
    }, timeoutMs);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", () => finish(null, null));
    child.on("close", (code: number | null, childSignal: NodeJS.Signals | null) => finish(code, childSignal));
  });

  const output = clampOutput(`${stdout.value}\n${stderr.value}`.trim());
  const failure = signal?.aborted
    ? "Pi child aborted."
    : result.signal
      ? `Pi child timed out or was terminated after ${timeoutMs}ms.`
      : result.code === 0
        ? ""
        : `Pi child exited with code ${result.code ?? "unknown"}.`;
  const text = failure ? `${failure}\n\n${output || "(no output)"}` : output || "Pi child completed with no output.";
  details.exitCode = result.code;
  await fs.writeFile(outputFile, text, "utf8");
  onUpdate?.(failure || "Pi child completed.");
  return { text, details };
}

export function buildPiChildArgsForTest(
  request: GstackBridgeRequest,
  files: { contextFile: string; taskFile: string; systemFile: string },
  model: string | undefined,
  tools: string,
): string[] {
  return buildChildArgs(request, files, model, tools);
}

export async function smokePiLaunchPlan(plan: PiLaunchPlan, timeoutMs = 5000): Promise<{ status: "ok" | "missing" | "failed"; output: string }> {
  if (plan.confidence === "missing") return { status: "missing", output: plan.warnings.join("\n") };
  const child = defaultSpawner(plan.command, [...plan.argsPrefix, "--version"], {
    cwd: process.cwd(),
    env: { ...process.env, ...plan.envPatch, PI_SKIP_VERSION_CHECK: "1" },
    shell: plan.shell,
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = { value: "" };
  const stderr = { value: "" };
  appendStream(child.stdout, stdout);
  appendStream(child.stderr, stderr);
  const result = await new Promise<{ code: number | null }>((resolve) => {
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      resolve({ code });
    };
    const timer = setTimeout(() => {
      terminateChild(child);
      finish(null);
    }, timeoutMs);
    child.on("error", () => finish(null));
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      finish(code);
    });
  });
  const output = clampOutput(`${stdout.value}\n${stderr.value}`.trim(), 4000);
  return { status: result.code === 0 ? "ok" : "failed", output: output || `(exit ${result.code ?? "unknown"})` };
}
