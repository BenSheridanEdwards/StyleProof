import path from 'node:path';

const WINDOWS_COMMANDS = new Map([
  ['npm', 'npm.cmd'],
  ['pnpm', 'pnpm.cmd'],
  ['yarn', 'yarn.cmd'],
  ['bun', 'bun.exe'],
  ['bunx', 'bunx.exe'],
]);

export function resolveSpawnCommand(command, platform = process.platform) {
  if (platform !== 'win32' || path.isAbsolute(command)) return command;
  return WINDOWS_COMMANDS.get(command) ?? command;
}
