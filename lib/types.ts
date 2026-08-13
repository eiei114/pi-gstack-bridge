export type GstackBridgeMode = "agent" | "review" | "challenge" | "consult" | "design";

export type PiLaunchSource = "configured" | "current-process" | "npm-shim" | "path" | "missing";
export type PiLaunchConfidence = "configured" | "high" | "medium" | "missing";

export interface PiLaunchPlan {
  command: string;
  argsPrefix: string[];
  envPatch: Record<string, string>;
  source: PiLaunchSource;
  confidence: PiLaunchConfidence;
  shell: boolean;
  warnings: string[];
}

export interface PiLaunchResolverOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  processArgv?: readonly string[];
  processExecPath?: string;
  fileExists?: (candidatePath: string) => boolean;
}

export interface GstackBridgeRequest {
  task: string;
  mode?: GstackBridgeMode;
  cwd?: string;
  model?: string;
  thinking?: string;
  tools?: string;
  timeoutMs?: number;
  readOnly?: boolean;
}

export interface GstackBridgeContext {
  cwd: string;
  parentModel?: string;
  recentUserMessages?: string[];
}

export interface GstackBridgeRunDetails {
  runtime: "pi-gstack-bridge";
  mode: GstackBridgeMode;
  cwd: string;
  model?: string;
  thinking?: string;
  tools: string;
  readOnly: boolean;
  timeoutMs: number;
  runDir: string;
  contextFile: string;
  taskFile: string;
  systemFile: string;
  outputFile: string;
  launchPlan: PiLaunchPlan;
  exitCode?: number | null;
}

export interface GstackBridgeRunResult {
  text: string;
  details: GstackBridgeRunDetails;
}
