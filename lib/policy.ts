const MODEL_CLI_NAMES = "codex|claude|gemini";

function matchDirectModelCli(text: string): string | undefined {
  const lookup = new RegExp(`\\b(?:command\\s+-v|which|where)\\s+(${MODEL_CLI_NAMES})(?:\\.exe)?\\b`, "iu");
  const lookupMatch = text.match(lookup);
  if (lookupMatch) return lookupMatch[1];

  const bareInvocation = new RegExp(
    `(?:^|[;&|\\n]\\s*)\\b(${MODEL_CLI_NAMES})(?:\\.exe)?(?=\\s*(?:\\d*>>?|&>|$))`,
    "iu",
  );
  const bareMatch = text.match(bareInvocation);
  if (bareMatch) return bareMatch[1];

  const invocation = new RegExp(
    `(?:^|[;&|\\n]\\s*|\\b(?:env|timeout|nohup|command)\\s+)(?:[^;&|\\n]*?\\s+)?\\b(${MODEL_CLI_NAMES})(?:\\.exe)?\\s+(?:exec|review|run|chat|login|--version|--help|-p|--prompt|--print|--model|--dangerously-skip-permissions)\\b`,
    "iu",
  );
  const invocationMatch = text.match(invocation);
  return invocationMatch?.[1];
}

function extractQuotedSegment(text: string, start: number): { content: string; end: number } | undefined {
  const quote = text[start];
  if (quote !== "\"" && quote !== "'") return undefined;
  let content = "";
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      content += text[i + 1];
      i++;
      continue;
    }
    if (ch === quote) return { content, end: i + 1 };
    content += ch;
  }
  return { content, end: text.length };
}

function unwrapShellSegments(text: string): string[] {
  const segments: string[] = [];
  const wrappers = [
    /\b(?:bash|sh)\b(?:\s+-[^\s"']*)*\s+-[a-z]*c\b\s*/giu,
    /\b(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\b(?:\s+-[^\s"']*)*\s+(?:-Command|-c)\b\s*/giu,
    /\bcmd(?:\.exe)?\b\s+\/c\b\s*/giu,
  ];

  for (const wrapper of wrappers) {
    let match: RegExpExecArray | null;
    wrapper.lastIndex = 0;
    while ((match = wrapper.exec(text)) !== null) {
      let i = wrapper.lastIndex;
      while (i < text.length && /\s/u.test(text[i]!)) i++;
      if (i >= text.length) continue;
      const quoted = extractQuotedSegment(text, i);
      const content = quoted ? quoted.content : text.slice(i);
      const trimmed = content.trim();
      if (trimmed) segments.push(trimmed);
      wrapper.lastIndex = quoted ? quoted.end : text.length;
    }
  }

  return segments;
}

export function directModelCli(command: string): string | undefined {
  const text = command.trim();
  if (!text) return undefined;

  const seen = new Set<string>();
  const stack = [text];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);

    const match = matchDirectModelCli(current);
    if (match) return match;

    for (const segment of unwrapShellSegments(current)) {
      if (!seen.has(segment)) stack.push(segment);
    }
  }

  return undefined;
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
