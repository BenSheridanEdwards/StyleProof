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

// cmd.exe metacharacters, caret-escaped after quoting (the cross-spawn rule).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
// Refuse characters cmd.exe cannot carry safely through a .cmd shim.
const CMD_UNSAFE = /["%!\r\n]/;

function quoteForCmd(arg) {
  return `"${arg}"`.replace(CMD_META, '^$1');
}

/**
 * Plan a spawnSync call. Windows .cmd/.bat shims need cmd.exe because Node rejects
 * direct spawns with EINVAL. Quote every argument so package ranges stay literal.
 */
export function resolveSpawnPlan(command, args, platform = process.platform, env = process.env) {
  const file = resolveSpawnCommand(command, platform);
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(file)) return { file, args, options: {} };
  const unsafe = [file, ...args].find((part) => CMD_UNSAFE.test(part));
  if (unsafe !== undefined) throw new Error(`cannot pass ${JSON.stringify(unsafe)} safely through cmd.exe`);
  const line = [file.replace(CMD_META, '^$1'), ...args.map(quoteForCmd)].join(' ');
  return {
    file: env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    options: { windowsVerbatimArguments: true },
  };
}
