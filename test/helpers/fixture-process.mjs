import { spawnSync } from 'node:child_process';

// A separate supervisor keeps the synchronous fixture API while its event loop
// enforces the deadline and kills descendants that inherited the process group.
export function fixtureProcess(command, args, options = {}) {
  const timeout = Number(options.timeout ?? process.env.STYLEPROOF_FIXTURE_TIMEOUT_MS ?? 60000);
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Invalid fixture deadline');
  const started = Date.now();
  const supervisor = `
    const { spawn } = require('node:child_process');
    const [command, args, options, timeout] = JSON.parse(process.argv[1]);
    const child = spawn(command, args, { ...options, detached: true });
    const output = { stdout: '', stderr: '', status: null };
    child.stdout.on('data', data => output.stdout += data);
    child.stderr.on('data', data => output.stderr += data);
    const timer = setTimeout(() => {
      output.timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
      process.stdout.write(JSON.stringify(output), () => process.exit(0));
    }, timeout);
    child.on('error', error => { output.error = error.message; });
    child.on('close', status => {
      clearTimeout(timer);
      output.status = status;
      process.stdout.write(JSON.stringify(output));
    });
    child.stdin.end(options.input?.type === 'Buffer' ? Buffer.from(options.input.data) : options.input);
  `;
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      supervisor,
      JSON.stringify([
        command,
        args,
        { ...options, env: { ...process.env, ...options.env, GIT_TERMINAL_PROMPT: '0' } },
        timeout,
      ]),
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(result.stderr || 'Fixture supervisor failed');
  const output = JSON.parse(result.stdout);
  if (output.timedOut) {
    throw new Error(
      `Fixture command ${command} ${args.join(' ')} exceeded deadline ${timeout} ms after ${Date.now() - started} ms; local git install may have stalled (check git submodule -h)`,
    );
  }
  if (output.error) throw new Error(output.error);
  return output;
}
