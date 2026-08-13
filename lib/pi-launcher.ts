import { existsSync } from "node:fs";
import * as posixPath from "node:path/posix";
import * as winPath from "node:path/win32";
import type {
  PiLaunchConfidence,
  PiLaunchPlan,
  PiLaunchResolverOptions,
  PiLaunchSource,
} from "./types.ts";

const BRIDGE_CLI_ENV = "PI_GSTACK_BRIDGE_CLI";
const BRIDGE_BIN_ENV = "PI_GSTACK_BRIDGE_PI_BIN";
const WINDOWS_PI_NAMES = ["pi.cmd", "pi.exe", "pi"] as const;
const POSIX_PI_NAMES = ["pi"] as const;

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function isWindows(platform: NodeJS.Platform): boolean {
  return platform === "win32";
}

function pathKey(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (!isWindows(platform)) return "PATH";
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
}

function pathValue(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  return env[pathKey(env, platform)] ?? "";
}

function splitPath(value: string, platform: NodeJS.Platform): string[] {
  return value.split(isWindows(platform) ? ";" : ":").filter(Boolean);
}

function joinPathEntry(directory: string, name: string, platform: NodeJS.Platform): string {
  if (isWindows(platform) && !directory.startsWith("/")) return winPath.join(directory, name);
  return posixPath.join(directory, name);
}

function dirname(value: string, platform: NodeJS.Platform): string {
  if (isWindows(platform) && !value.startsWith("/")) return winPath.dirname(value);
  return posixPath.dirname(value);
}

function basename(value: string, platform: NodeJS.Platform): string {
  if (isWindows(platform) && !value.startsWith("/")) return winPath.basename(value);
  return posixPath.basename(value);
}

function prependPath(env: NodeJS.ProcessEnv, directory: string, platform: NodeJS.Platform): string {
  const key = pathKey(env, platform);
  const separator = isWindows(platform) ? ";" : ":";
  const entries = splitPath(pathValue(env, platform), platform);
  const normalized = directory.replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
  const filtered = entries.filter(
    (entry) => entry.replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase() !== normalized,
  );
  return [directory, ...filtered].join(separator);
}

function isPiCliPath(value: string): boolean {
  return /(?:^|[/\\])pi-coding-agent[/\\]dist[/\\]cli(?:\.js)?$/iu.test(value);
}

function isPathLike(value: string): boolean {
  return value.includes("/") || value.includes("\\") || value.startsWith(".");
}

function cliPlan(
  cliPath: string,
  source: PiLaunchSource,
  confidence: PiLaunchConfidence,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  processExecPath: string,
  warnings: string[] = [],
): PiLaunchPlan {
  const directory = dirname(cliPath, platform);
  return {
    command: processExecPath,
    argsPrefix: [cliPath],
    envPatch: {
      [BRIDGE_CLI_ENV]: cliPath,
      ["PI_GSTACK_BRIDGE_RESOLVED"]: "1",
      [pathKey(env, platform)]: prependPath(env, directory, platform),
    },
    source,
    confidence,
    shell: false,
    warnings,
  };
}

function shimCliPath(shimPath: string, platform: NodeJS.Platform, fileExists: (candidatePath: string) => boolean): string | undefined {
  const directories = new Set<string>([
    dirname(shimPath, platform),
    posixPath.dirname(shimPath),
    winPath.dirname(shimPath),
  ]);
  for (const directory of directories) {
    const candidate = joinPathEntry(
      joinPathEntry(joinPathEntry(directory, "node_modules", platform), "@earendil-works", platform),
      "pi-coding-agent",
      platform,
    );
    const cli = joinPathEntry(joinPathEntry(candidate, "dist", platform), "cli.js", platform);
    if (fileExists(cli)) return cli;
  }
  return undefined;
}

function buildShimPlan(
  shimPath: string,
  source: PiLaunchSource,
  confidence: PiLaunchConfidence,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  processExecPath: string,
  fileExists: (candidatePath: string) => boolean,
): PiLaunchPlan {
  const cli = shimCliPath(shimPath, platform, fileExists);
  if (cli) return cliPlan(cli, source, confidence, env, platform, processExecPath);

  const directory = dirname(shimPath, platform);
  return {
    command: shimPath,
    argsPrefix: [],
    envPatch: {
      ["PI_BIN"]: shimPath,
      ["PI_GSTACK_BRIDGE_RESOLVED"]: "1",
      [pathKey(env, platform)]: prependPath(env, directory, platform),
    },
    source: "npm-shim",
    confidence,
    shell: platform === "win32" && /\.cmd$/iu.test(shimPath),
    warnings: ["Using a package-manager shim; Node CLI resolution was unavailable."],
  };
}

function candidateNames(platform: NodeJS.Platform): readonly string[] {
  return isWindows(platform) ? WINDOWS_PI_NAMES : POSIX_PI_NAMES;
}

function addUnique(items: string[], value: string | undefined): void {
  if (!value || items.includes(value)) return;
  items.push(value);
}

function candidateDirectories(options: PiLaunchResolverOptions, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const directories: string[] = [];
  const prefix = firstNonEmpty(env.npm_config_prefix, env.PREFIX);
  if (prefix) addUnique(directories, isWindows(platform) ? prefix : posixPath.join(prefix, "bin"));
  if (isWindows(platform) && env.APPDATA) addUnique(directories, winPath.join(env.APPDATA, "npm"));
  if (options.processExecPath && isPathLike(options.processExecPath)) {
    addUnique(directories, dirname(options.processExecPath, platform));
  }
  for (const entry of splitPath(pathValue(env, platform), platform)) addUnique(directories, entry);
  return directories;
}

function createMissingPlan(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): PiLaunchPlan {
  return {
    command: isWindows(platform) ? "pi.cmd" : "pi",
    argsPrefix: [],
    envPatch: {},
    source: "missing",
    confidence: "missing",
    shell: false,
    warnings: [
      "No runnable Pi CLI was found. Set PI_GSTACK_BRIDGE_CLI to pi-coding-agent/dist/cli.js or PI_GSTACK_BRIDGE_PI_BIN to a Pi executable.",
    ],
  };
}

export function resolvePiLaunchPlan(options: PiLaunchResolverOptions = {}): PiLaunchPlan {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const processArgv = options.processArgv ?? process.argv;
  const processExecPath = options.processExecPath ?? process.execPath;
  const fileExists = options.fileExists ?? existsSync;

  const configuredCli = firstNonEmpty(env[BRIDGE_CLI_ENV]);
  if (configuredCli) {
    if (isPiCliPath(configuredCli) && fileExists(configuredCli)) {
      return cliPlan(configuredCli, "configured", "configured", env, platform, processExecPath);
    }
    return {
      ...buildShimPlan(configuredCli, "configured", "configured", env, platform, processExecPath, fileExists),
      warnings: [`Configured Pi CLI path is not a verified pi-coding-agent CLI: ${configuredCli}`],
    };
  }

  const currentCli = processArgv[1];
  if (currentCli && isPiCliPath(currentCli) && fileExists(currentCli)) {
      return cliPlan(currentCli, "current-process", "high", env, platform, processExecPath);
  }

  const configuredBin = firstNonEmpty(env[BRIDGE_BIN_ENV], env.PI_BIN);
  if (configuredBin) {
    if (isPiCliPath(configuredBin) && fileExists(configuredBin)) {
      return cliPlan(configuredBin, "configured", "configured", env, platform, processExecPath);
    }
    if (fileExists(configuredBin)) {
      return buildShimPlan(configuredBin, "configured", "configured", env, platform, processExecPath, fileExists);
    }
  }

  for (const directory of candidateDirectories({ ...options, processExecPath }, env, platform)) {
    for (const name of candidateNames(platform)) {
      const candidate = joinPathEntry(directory, name, platform);
      if (!fileExists(candidate)) continue;
      return buildShimPlan(candidate, "path", "high", env, platform, processExecPath, fileExists);
    }
  }

  return createMissingPlan(env, platform);
}

export function applyPiLaunchPlan(plan: PiLaunchPlan, env: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of Object.entries(plan.envPatch)) env[key] = value;
}

export function renderPiLaunchPlan(plan: PiLaunchPlan): string {
  return [
    `command: ${plan.command}`,
    `argsPrefix: ${plan.argsPrefix.length ? JSON.stringify(plan.argsPrefix) : "[]"}`,
    `source: ${plan.source}`,
    `confidence: ${plan.confidence}`,
    `shell: ${plan.shell}`,
    `envPatch: ${JSON.stringify(plan.envPatch)}`,
    ...(plan.warnings.length ? ["warnings:", ...plan.warnings.map((warning) => `- ${warning}`)] : []),
  ].join("\n");
}

export function isRunnablePlan(plan: PiLaunchPlan): boolean {
  return plan.confidence !== "missing" && Boolean(plan.command);
}
