import path from 'node:path';

const WINDOWS_COMMANDS = new Map([
  ['npm', 'npm.cmd'],
  ['pnpm', 'pnpm.cmd'],
  ['yarn', 'yarn.cmd'],
  ['bun', 'bun.exe'],
  ['bunx', 'bunx.exe'],
]);

// Node on Windows refuses to spawn a .cmd file directly (EINVAL since the CVE-2024-27980 fix),
// so a .cmd shim runs through cmd.exe the way Node's own `shell` option does. Every argument
// is double-quoted so cmd.exe keeps metacharacters such as the `>` in `@playwright/test@>=1.45`
// literal instead of reading a redirect. Setup's arguments never contain `"` or `%`.
export function resolveSpawn(command, args, platform = process.platform) {
  if (platform !== 'win32' || path.isAbsolute(command)) return { file: command, args, options: {} };
  const file = WINDOWS_COMMANDS.get(command) ?? command;
  if (!file.endsWith('.cmd')) return { file, args, options: {} };
  const line = [file, ...args].map((arg) => `"${arg}"`).join(' ');
  return {
    file: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    options: { windowsVerbatimArguments: true },
  };
}
