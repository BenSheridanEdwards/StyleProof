import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { captureStyleMap, trackScriptReach } from '../dist/capture.js';

for (const [bundlePath, outOfTree, mismatch] of [
  ['app.js', false, false],
  ['assets/app.js', false, false],
  ['app.js', true, false],
  ['app.js', false, true],
] as const) {
  test(`HTTP production bundle maps above-root sources: /${bundlePath}${outOfTree ? ' (out-of-tree output)' : ''}${mismatch ? ' (local hash mismatch)' : ''}`, async ({
    page,
  }, testInfo) => {
    const app = testInfo.outputPath('app');
    const sources = {
      'src/app.ts': `import { css } from ${JSON.stringify('./css')};\ndocument.body.className = css();\n`,
      'src/css.ts': 'export function css() { return "ready"; }\n',
    };
    await mkdir(path.join(app, 'src'), { recursive: true });
    for (const [filename, content] of Object.entries(sources)) await writeFile(path.join(app, filename), content);
    const projectRoot = await realpath(app);
    const outfile = outOfTree
      ? path.join(path.parse(projectRoot).root, 'styleproof-out', 'public', bundlePath)
      : path.join(projectRoot, 'public', bundlePath);
    const built = await build({
      absWorkingDir: projectRoot,
      entryPoints: ['src/app.ts'],
      outfile,
      bundle: true,
      sourcemap: true,
      format: 'iife',
      write: false,
    });
    const script = built.outputFiles.find((file) => file.path.endsWith('.js'))!;
    const sourceMap = built.outputFiles.find((file) => file.path.endsWith('.map'))!;
    expect(JSON.parse(sourceMap.text).sources.sort()).toEqual(
      Object.keys(sources)
        .map((filename) => path.relative(path.dirname(outfile), path.join(projectRoot, filename)).replaceAll('\\', '/'))
        .sort(),
    );
    if (mismatch) await writeFile(path.join(projectRoot, 'src/app.ts'), 'changed after the build');
    const server = http.createServer((request, response) => {
      const body =
        request.url === `/${bundlePath}`
          ? script.text
          : request.url === `/${bundlePath}.map`
            ? sourceMap.text
            : undefined;
      response.setHeader(
        'Content-Type',
        request.url?.endsWith('.map') ? 'application/json' : body ? 'application/javascript' : 'text/html',
      );
      response.end(body ?? `<!doctype html><body><p>Ready</p><script src="/${bundlePath}"></script></body>`);
    });
    // Keep the OS-assigned port bound throughout capture; no probe/rebind race or child process.
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP fixture has no TCP address');
    const url = `http://127.0.0.1:${address.port}`;
    const tracker = await trackScriptReach(page, { projectRoot });
    try {
      await page.goto(url);
      await expect(page.locator('body')).toHaveClass('ready');
      const map = await captureStyleMap(page, {
        captureScriptReach: true,
        scriptReach: tracker,
        captureStates: false,
        stabilize: false,
      });
      const bundle = map.scriptReach?.scripts.find((entry) => entry.url === `${url}/${bundlePath}`);
      process.stdout.write(`Bundler capture: ${JSON.stringify(bundle)}\n`);
      if (mismatch) {
        expect(bundle?.status).toBe('unknown');
        expect(bundle?.reason).toBe('source path escapes URL root');
        expect(bundle?.files).toBeUndefined();
        return;
      }
      expect(bundle?.status).toBe('mapped');
      expect(bundle?.files?.map((file) => file.sourceKey).sort()).toEqual(['src/app.ts', 'src/css.ts']);
      for (const [sourceKey, content] of Object.entries(sources)) {
        const file = bundle?.files?.find((entry) => entry.sourceKey === sourceKey);
        expect(file?.contentHash).toBe(createHash('sha256').update(content).digest('hex'));
        expect(file?.executed.length).toBeGreaterThan(0);
      }
    } finally {
      await tracker.dispose();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
}
