const MODEL_CLI_NAMES = "codex|claude|gemini";

export function directModelCli(command: string): string | undefined {
  const text = command.trim();
  if (!text) return undefined;

  const lookup = new RegExp(`\\b(?:command\\s+-v|which|where)\\s+(${MODEL_CLI_NAMES})(?:\\.exe)?\\b`, "iu");
  const lookupMatch = text.match(lookup);
  if (lookupMatch) return lookupMatch[1];

  const invocation = new RegExp(
    `(?:^|[;&|]\\s*|\\b(?:env|timeout|nohup|command)\\s+)(?:[^;&|]*?\\s+)?\\b(${MODEL_CLI_NAMES})(?:\\.exe)?\\s+(?:exec|review|run|chat|login|--version)\\b`,
    "iu",
  );
  const invocationMatch = text.match(invocation);
  return invocationMatch?.[1];
}

export function directModelCliReason(command: string): string | undefined {
  const cli = directModelCli(command);
  return cli
    ? `Direct ${cli} CLI execution is disabled. Use gstack_pi_agent or gstack_pi_review so the work runs through Pi.`
    : undefined;
}

export function mutatingShellCommand(command: string): string | undefined {
  const text = command.trim();
  if (!text) return undefined;
  const patterns: Array<[RegExp, string]> = [
    [/\b(?:rm|rmdir|del|erase)\b/iu, "delete command"],
    [/\b(?:mv|move|cp|copy|touch|mkdir|md|chmod|chown)\b/iu, "filesystem mutation"],
    [/>\s*>?/u, "shell redirection"],
    [/\b(?:git\s+(?:reset|clean|checkout|restore|switch|commit|merge|rebase|cherry-pick|apply|push|tag))\b/iu, "git mutation"],
    [/\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|remove|uninstall|publish|version)\b/iu, "package mutation"],
    [/(?:sed|perl)\s+[^\n]*\s-i(?:\s|$)/iu, "in-place edit"],
  ];
  for (const [pattern, reason] of patterns) {
    if (pattern.test(text)) return reason;
  }
  return undefined;
}
