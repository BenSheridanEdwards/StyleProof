import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function createRunTmp({ prefix = 'styleproof-run-', parent = os.tmpdir() } = {}) {
  const dir = fs.mkdtempSync(path.join(parent, `${prefix}${process.pid}-`));

  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export function sweepStaleRunTmp({ prefix = 'styleproof-run-', parent = os.tmpdir() } = {}) {
  const removed = [];

  let entries;

  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return removed;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const match = /^([1-9]\d*)-[A-Za-z0-9]+$/.exec(entry.name.slice(prefix.length));
    const pid = Number(match?.[1]);

    if (!Number.isSafeInteger(pid) || pid === process.pid) continue;
    const dir = path.join(parent, entry.name);

    if (removeDeadRunTmp(dir, pid)) removed.push(dir);
  }

  return removed;
}

function removeDeadRunTmp(dir, pid) {
  try {
    const stat = fs.lstatSync(dir);

    if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) return false;

    try {
      process.kill(pid, 0);

      return false;
    } catch (error) {
      if (error.code !== 'ESRCH') return false;
    }

    fs.rmSync(dir, { recursive: true, force: true });

    return true;
  } catch {
    // Shared temp entries may be unreadable or impossible to remove.
    return false;
  }
}

export async function runWithTmp(command, args, { cwd, env = process.env, prefix } = {}) {
  const parent = env.TMPDIR || env.TMP || env.TEMP || os.tmpdir();
  sweepStaleRunTmp({ prefix, parent });
  const root = createRunTmp({ prefix, parent });

  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env: { ...env, TMPDIR: root.dir, TMP: root.dir, TEMP: root.dir },
        stdio: 'inherit',
      });

      let interruptTimer;
      const signals = process.platform === 'win32' ? ['SIGTERM'] : ['SIGTERM', 'SIGHUP'];
      const handlers = new Map(signals.map((signal) => [signal, () => child.kill(signal)]));
      handlers.set('SIGINT', () => {
        // Terminal SIGINT already reaches the child's process group.
        interruptTimer ??= setTimeout(() => child.kill('SIGINT'), 3000);
      });

      const detach = () => {
        clearTimeout(interruptTimer);

        for (const [signal, handler] of handlers) process.off(signal, handler);
      };

      for (const [signal, handler] of handlers) process.on(signal, handler);
      child.once('error', (error) => {
        detach();
        reject(error);
      });
      child.once('exit', (code, signal) => {
        detach();
        resolve(signal ? 128 + os.constants.signals[signal] : code);
      });
    });
  } finally {
    root.cleanup();
  }
}
