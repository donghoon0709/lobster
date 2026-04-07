export function resolveInlineShellCommand({
  command,
  env,
  platform = process.platform,
}: {
  command: string;
  env: Record<string, string | undefined>;
  platform?: string;
}) {
  const shellOverride = String(env?.LOBSTER_SHELL ?? '').trim();
  const isWindows = platform === 'win32';

  if (shellOverride) {
    return {
      command: shellOverride,
      argv: buildShellArgs({ shellCommand: shellOverride, command, isWindows }),
    };
  }

  if (isWindows) {
    const comspec = String(env?.ComSpec ?? env?.COMSPEC ?? 'cmd.exe').trim() || 'cmd.exe';
    return {
      command: comspec,
      argv: ['/d', '/s', '/c', command],
    };
  }

  // Prefer the current shell from the process environment so Lobster follows the
  // user's active shell semantics more closely. Still avoid login-shell semantics
  // here. `-l` reloads profile files and can resurrect stale PATH entries, which
  // makes commands like `node` resolve to a different binary than the current
  // Lobster process environment.
  const shellFromEnv = String(env?.SHELL ?? '').trim();
  const shell = shellFromEnv || '/bin/sh';
  return {
    command: shell,
    argv: buildShellArgs({ shellCommand: shell, command, isWindows }),
  };
}

export function normalizeSpawnEnv(env: Record<string, string | undefined>) {
  const currentNodeDir = process.execPath.replace(/\/[^/]+$/, '');
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const currentPath = String(env[pathKey] ?? process.env[pathKey] ?? process.env.PATH ?? '');
  const parts = currentPath
    .split(':')
    .map((part) => part.trim())
    .filter(Boolean);
  const deduped = [currentNodeDir, ...parts.filter((part) => part !== currentNodeDir)];
  return {
    ...env,
    [pathKey]: deduped.join(':'),
  };
}

function buildShellArgs({
  shellCommand,
  command,
  isWindows,
}: {
  shellCommand: string;
  command: string;
  isWindows: boolean;
}) {
  const lowered = shellCommand.toLowerCase();
  const looksLikeCmd = lowered.endsWith('cmd') || lowered.endsWith('cmd.exe');
  const looksLikePowerShell =
    lowered.endsWith('powershell') ||
    lowered.endsWith('powershell.exe') ||
    lowered.endsWith('pwsh') ||
    lowered.endsWith('pwsh.exe');
  const looksLikeZsh = lowered.endsWith('/zsh') || lowered.endsWith('zsh');
  const looksLikeBash = lowered.endsWith('/bash') || lowered.endsWith('bash') || lowered.endsWith('bash.exe');

  if (looksLikePowerShell) {
    return ['-NoProfile', '-Command', command];
  }
  if (looksLikeCmd || isWindows) {
    return ['/d', '/s', '/c', command];
  }
  if (looksLikeZsh) {
    return ['-f', '-c', `setopt no_nomatch 2>/dev/null; ${command}`];
  }
  if (looksLikeBash) {
    return ['--noprofile', '--norc', '-c', command];
  }
  return ['-c', command];
}
