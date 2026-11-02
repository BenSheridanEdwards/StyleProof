import { spawnSync } from 'node:child_process';

export function fixtureProcess(command, args, options = {}) {
  const { timeout = process.env.STYLEPROOF_FIXTURE_TIMEOUT_MS ?? 60000, input, encoding, ...rest } = options;
  const deadline = Number(timeout);
  if (!Number.isFinite(deadline) || deadline <= 0) throw new Error('Invalid fixture deadline');
  const started = Date.now();
  const supervisor = `
    const { spawn } = require('node:child_process');
    let request = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', data => request += data);
    process.stdin.on('end', () => {
      const [command, args, options, input, timeout] = JSON.parse(request);
      const child = spawn(command, args, { ...options, detached: true });
      const stdout = [], stderr = [];
      const output = { status: null, signal: null };
      const finish = () => {
        output.stdout = Buffer.concat(stdout).toString('base64');
        output.stderr = Buffer.concat(stderr).toString('base64');
        process.stdout.write(JSON.stringify(output), () => process.exit(0));
      };
      child.stdout.on('data', data => stdout.push(data));
      child.stderr.on('data', data => stderr.push(data));
      child.stdin.on('error', error => {
        if (error.code !== 'EPIPE') output.error = { message: error.message, ...error };
      });
      const timer = setTimeout(() => {
        output.timedOut = true;
        // Group cleanup is POSIX-only; refused kills may leave descendants alive.
        try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
          if (error.code !== 'ESRCH') { output.killError = error.message; child.kill('SIGKILL'); }
        }
        finish();
      }, timeout);
      child.on('error', error => { output.error = { message: error.message, ...error }; });
      child.on('close', (status, signal) => {
        clearTimeout(timer);
        Object.assign(output, { status: output.error ? null : status, signal });
        finish();
      });
      child.stdin.end(input === null ? undefined : Buffer.from(input, 'base64'));
    });
  `;
  const result = spawnSync(process.execPath, ['-e', supervisor], {
    input: JSON.stringify([
      command,
      args,
      { ...rest, env: { ...(options.env ?? process.env), GIT_TERMINAL_PROMPT: '0' } },
      input == null
        ? null
        : (typeof input === 'string' ? Buffer.from(input, encoding) : Buffer.from(input)).toString('base64'),
      deadline,
    ]),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: deadline + 5000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || 'Fixture supervisor failed');
  const output = JSON.parse(result.stdout);
  if (output.timedOut)
    throw new Error(
      `Fixture command ${command} ${args.join(' ')} exceeded deadline ${deadline} ms after ${Date.now() - started} ms; local git install may have stalled (check git submodule -h)${output.killError ? '; process-group kill failed: ' + output.killError : ''}`,
    );
  for (const key of ['stdout', 'stderr']) {
    const buffer = Buffer.from(output[key], 'base64');
    output[key] = encoding && encoding !== 'buffer' ? buffer.toString(encoding) : buffer;
  }
  if (output.error) output.error = Object.assign(new Error(output.error.message), output.error);
  return output;
}
