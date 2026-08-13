import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { Type, type Static } from "typebox";
import { applyPiLaunchPlan, isRunnablePlan, renderPiLaunchPlan, resolvePiLaunchPlan } from "../lib/pi-launcher.ts";
import { directModelCliReason, mutatingShellCommand } from "../lib/policy.ts";
import { runPiChild, smokePiLaunchPlan } from "../lib/runner.ts";
import type { GstackBridgeContext, GstackBridgeMode, GstackBridgeRequest } from "../lib/types.ts";

const require = createRequire(import.meta.url);

const modeValues = ["agent", "review", "challenge", "consult", "design"] as const;

const bridgeParameters = Type.Object({
  task: Type.String({ description: "Focused task for the independent Pi child." }),
  mode: Type.Optional(Type.String({ enum: [...modeValues], description: "gstack work mode." })),
  cwd: Type.Optional(Type.String({ description: "Repository working directory. Defaults to the current Pi cwd." })),
  model: Type.Optional(Type.String({ description: "Pi model override, for example openai-codex/gpt-5-codex." })),
  thinking: Type.Optional(Type.String({ description: "Pi thinking level override." })),
  tools: Type.Optional(Type.String({ description: "Comma-separated child Pi tool allowlist." })),
  timeoutMs: Type.Optional(Type.Number({ description: "Child timeout in milliseconds." })),
  readOnly: Type.Optional(Type.Boolean({ description: "Keep the child review read-only. Defaults to true." })),
});
type BridgeParameters = Static<typeof bridgeParameters>;

const compatibilityParameters = Type.Object(
  {
    prompt: Type.Optional(Type.String()),
    task: Type.Optional(Type.String()),
    instructions: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    subagent_type: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    cwd: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    thinking: Type.Optional(Type.String()),
    tools: Type.Optional(Type.String()),
    readOnly: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: true },
);
type CompatibilityParameters = Static<typeof compatibilityParameters>;

function normalizedMode(value: unknown): GstackBridgeMode {
  return modeValues.includes(value as GstackBridgeMode) ? (value as GstackBridgeMode) : "agent";
}

function textParam(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function parentModelSpec(ctx: { model?: { provider?: string; id?: string } }): string | undefined {
  const model = ctx.model;
  if (!model?.id) return undefined;
  return model.provider && !model.id.startsWith(`${model.provider}/`) ? `${model.provider}/${model.id}` : model.id;
}

function recentUserMessages(ctx: { sessionManager?: { getBranch?: () => unknown[] } }): string[] {
  try {
    const branch = ctx.sessionManager?.getBranch?.() ?? [];
    const messages: string[] = [];
    for (const entry of [...branch].reverse()) {
      const candidate = entry as { type?: string; message?: { role?: string; content?: unknown } };
      if (candidate.type !== "message" || candidate.message?.role !== "user") continue;
      const content = candidate.message.content;
      const text = typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((part) => (part as { type?: string; text?: string }).type === "text" ? (part as { text: string }).text : "").join(" ")
          : "";
      if (text.trim()) messages.push(text.trim().slice(0, 500));
      if (messages.length >= 4) break;
    }
    return messages.reverse();
  } catch {
    return [];
  }
}

function toRequest(params: BridgeParameters | CompatibilityParameters, defaultMode: GstackBridgeMode): GstackBridgeRequest | undefined {
  const task = textParam(
    params.task,
    "prompt" in params ? params.prompt : undefined,
    "instructions" in params ? params.instructions : undefined,
    "description" in params ? params.description : undefined,
  );
  if (!task) return undefined;
  return {
    task,
    mode: normalizedMode("mode" in params ? params.mode : defaultMode),
    cwd: textParam(params.cwd),
    model: textParam(params.model),
    thinking: textParam(params.thinking),
    tools: textParam(params.tools),
    timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : undefined,
    readOnly: params.readOnly !== false,
  };
}

function toolResult(text: string, details: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

type GstackExtension = (pi: ExtensionAPI) => void | Promise<void>;

function loadGstackExtension(): GstackExtension | undefined {
  try {
    const loaded = require("pi-gstack/extensions/gstack.js") as { default?: GstackExtension } | GstackExtension;
    return typeof loaded === "function" ? loaded : loaded.default;
  } catch {
    return undefined;
  }
}

function registerGstackSurfaceWithoutLegacyAgents(pi: ExtensionAPI): boolean {
  const gstackExtension = loadGstackExtension();
  if (!gstackExtension) return false;

  // pi-gstack owns the skills, safety hooks, compatibility helpers, and
  // gstack-* commands. Its legacy Agent/Task registrations are deliberately
  // filtered here so this extension can register the Pi-routed replacements
  // without triggering Pi's duplicate-tool diagnostic.
  const delegatedPi = new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "registerTool") {
        return (definition: { name?: string }) => {
          if (definition.name === "Agent" || definition.name === "Task") return;
          return target.registerTool(definition as Parameters<ExtensionAPI["registerTool"]>[0]);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ExtensionAPI;

  void gstackExtension(delegatedPi);
  return true;
}

function statusText(pi: ExtensionAPI): string {
  const plan = resolvePiLaunchPlan();
  const nativeSubagents = pi.getAllTools?.()?.some((tool) => tool.name === "subagent") ?? false;
  return [
    "pi-gstack-bridge",
    "",
    `Pi child launch: ${isRunnablePlan(plan) ? "ready" : "missing"}`,
    `Native pi-subagents tool: ${nativeSubagents ? "present" : "not detected"}`,
    "Direct Codex/Claude/Gemini CLI: blocked",
    "Agent/Task compatibility: routed through Pi child",
    "",
    renderPiLaunchPlan(plan),
  ].join("\n");
}

async function runRequest(
  request: GstackBridgeRequest,
  ctx: { cwd: string; model?: { provider?: string; id?: string }; sessionManager?: { getBranch?: () => unknown[] } },
  signal: AbortSignal | undefined,
  onUpdate: ((text: string) => void) | undefined,
) {
  const context: GstackBridgeContext = {
    cwd: request.cwd || ctx.cwd,
    parentModel: parentModelSpec(ctx),
    recentUserMessages: recentUserMessages(ctx),
  };
  const result = await runPiChild(request, context, signal, (text) => {
    onUpdate?.(text);
  });
  return toolResult(result.text, result.details);
}

function registerBridgeTool(pi: ExtensionAPI, name: string, label: string, description: string, mode: GstackBridgeMode): void {
  pi.registerTool({
    name,
    label,
    description,
    parameters: bridgeParameters,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const request = toRequest(params, mode);
      if (!request) return toolResult("No child task was provided.", {});
      return runRequest(request, ctx, signal, (text) => onUpdate?.({ content: [{ type: "text", text }], details: {} }));
    },
  });
}

export default function piGstackBridge(pi: ExtensionAPI): void {
  registerGstackSurfaceWithoutLegacyAgents(pi);

  pi.on("session_start", async () => {
    if (process.env.PI_GSTACK_BRIDGE_CHILD === "1") return;
    applyPiLaunchPlan(resolvePiLaunchPlan());
  });

  pi.on("before_agent_start", async (event) => {
    if (process.env.PI_GSTACK_BRIDGE_CHILD === "1") return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n## pi-gstack-bridge routing\n- All gstack specialist, review, challenge, consult, and design-agent work MUST run through Pi.\n- Use gstack_pi_agent or gstack_pi_review; Agent and Task are also routed through the same Pi child launcher.\n- Never invoke codex, claude, or gemini CLI from bash. Those calls are blocked.\n- Preserve independent second opinions by selecting a different Pi provider/model, not by launching a model CLI.`,
    };
  });

  pi.on("tool_call", async (event) => {
    const command = event.toolName === "bash" ? String(event.input?.command ?? "") : "";
    const directCli = directModelCliReason(command);
    if (directCli) return { block: true, reason: directCli };

    if (process.env.PI_GSTACK_BRIDGE_CHILD === "1" && process.env.PI_GSTACK_BRIDGE_READ_ONLY === "1") {
      if (event.toolName === "edit" || event.toolName === "write") {
        return { block: true, reason: "Read-only gstack Pi child cannot edit files." };
      }
      if (event.toolName === "bash") {
        const mutation = mutatingShellCommand(command);
        if (mutation) return { block: true, reason: `Read-only gstack Pi child blocked ${mutation}.` };
      }
    }
  });

  pi.on("user_bash", async (event) => {
    const reason = directModelCliReason(event.command);
    if (!reason) return;
    return {
      result: {
        output: `${reason}\n`,
        exitCode: 126,
        cancelled: false,
        truncated: false,
      },
    };
  });

  registerBridgeTool(
    pi,
    "gstack_pi_agent",
    "gstack Pi Agent",
    "Run a focused gstack specialist task as a child Pi session. Never launches Codex, Claude, or Gemini CLI.",
    "agent",
  );
  registerBridgeTool(
    pi,
    "gstack_pi_review",
    "gstack Pi Review",
    "Run an independent read-only gstack code review as a child Pi session.",
    "review",
  );

  pi.registerTool({
    name: "Agent",
    label: "Agent (Pi-routed)",
    description: "Compatibility Agent tool for gstack. Always runs the specialist as a child Pi session.",
    parameters: compatibilityParameters,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const request = toRequest(params, "agent");
      if (!request) return toolResult("No subagent prompt was provided.", {});
      if (params.subagent_type) request.task = `Specialist type: ${params.subagent_type}\n\n${request.task}`;
      return runRequest(request, ctx, signal, (text) => onUpdate?.({ content: [{ type: "text", text }], details: {} }));
    },
  });
  pi.registerTool({
    name: "Task",
    label: "Task (Pi-routed)",
    description: "Compatibility Task tool for gstack. Always runs the specialist as a child Pi session.",
    parameters: compatibilityParameters,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const request = toRequest(params, "agent");
      if (!request) return toolResult("No subagent prompt was provided.", {});
      if (params.subagent_type) request.task = `Specialist type: ${params.subagent_type}\n\n${request.task}`;
      return runRequest(request, ctx, signal, (text) => onUpdate?.({ content: [{ type: "text", text }], details: {} }));
    },
  });

  pi.registerTool({
    name: "gstack_bridge_status",
    label: "gstack Bridge Status",
    description: "Show pi-gstack-bridge launch and routing status.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      return toolResult(statusText(pi), { plan: resolvePiLaunchPlan() });
    },
  });

  pi.registerCommand("gstack-bridge:status", {
    description: "Show pi-gstack-bridge routing status.",
    handler: async (_args, ctx) => ctx.ui.notify(statusText(pi), "info"),
  });
  pi.registerCommand("gstack-bridge:doctor", {
    description: "Verify that pi-gstack-bridge can launch a Pi child.",
    handler: async (_args, ctx) => {
      const plan = resolvePiLaunchPlan();
      const smoke = await smokePiLaunchPlan(plan);
      ctx.ui.notify(`${statusText(pi)}\n\nSmoke test: ${smoke.status}\n${smoke.output}`, smoke.status === "ok" ? "info" : "warning");
    },
  });
}
