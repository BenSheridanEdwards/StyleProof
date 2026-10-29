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

  for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const match = /^([1-9]\d*)-[A-Za-z0-9]+$/.exec(entry.name.slice(prefix.length));

    if (!match) continue;
    const pid = Number(match[1]);

    if (!Number.isSafeInteger(pid) || pid === process.pid) continue;

    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code !== 'ESRCH') continue;
      const dir = path.join(parent, entry.name);
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    }
  }

  return removed;
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

      const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => [signal, () => child.kill(signal)]));

      const detach = () => {
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
