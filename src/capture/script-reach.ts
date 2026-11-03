/** Navigation-window script coverage. Reader failures are evidence gaps, never capture failures. */
import type { CaptureOptions, StyleMap } from './types.js';
import type { CDPSession, Page, Response } from '@playwright/test';
import { mapScriptCoverage, type ScriptReach, type ScriptReachEntry } from '../script-reach.js';

type ParsedScript = { scriptId: string; url: string; sourceMapURL?: string };
export type ScriptReachTracker = {
  stop: () => Promise<ScriptReach>;
  dispose: () => Promise<void>;
};

export function unmeasuredScriptReach(reason: string): ScriptReach {
  return { version: 1, window: 'navigation', status: 'unmeasured', reason, scripts: [] };
}

/** Attach only opt-in evidence; custom trackers are also allowed to fail without losing the map. */
export async function attachScriptReach(map: StyleMap, options: CaptureOptions): Promise<void> {
  if (!options.captureScriptReach) return;
  try {
    map.scriptReach = options.scriptReach
      ? await options.scriptReach.stop()
      : unmeasuredScriptReach('pre-navigation script tracker absent');
  } catch {
    map.scriptReach = {
      version: 1,
      window: 'navigation',
      status: 'unknown',
      reason: 'script coverage could not be read',
      scripts: [],
    };
  }
}

async function readResource(page: Page, client: CDPSession, url: string): Promise<string> {
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',');
    if (comma < 0) throw new Error('invalid data URL');
    return /;base64$/i.test(url.slice(0, comma))
      ? Buffer.from(url.slice(comma + 1), 'base64').toString('utf8')
      : decodeURIComponent(url.slice(comma + 1));
  }
  if (url.startsWith('file:')) return readFileResource(page, url);
  // Page fetch preserves the page's credentials, routing and test fixtures.
  try {
    return await page.evaluate(async (address) => {
      const response = await fetch(address, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('source map request failed');
      return response.text();
    }, url);
  } catch {
    // CDP can load cross-origin maps when the page's fetch is restricted by CORS.
    const { frameTree } = await client.send('Page.getFrameTree');
    const { resource } = await client.send('Network.loadNetworkResource', {
      frameId: frameTree.frame.id,
      url,
      options: { disableCache: false, includeCredentials: true },
    });
    if (!resource.success || !resource.stream) throw new Error('source map request failed');
    return readStream(client, resource.stream);
  }
}

/** Chromium forbids file-origin fetch and CDP's network loader rejects file URLs. */
async function readFileResource(page: Page, url: string): Promise<string> {
  const browser = page.context().browser();
  if (!browser) throw new Error('browser unavailable for file source map');
  const resourcePage = await browser.newPage();
  try {
    const response = await resourcePage.goto(url, { waitUntil: 'load', timeout: 5000 });
    if (!response?.ok()) throw new Error('file source map request failed');
    return await response.text();
  } finally {
    await resourcePage.close();
  }
}

async function readStream(client: CDPSession, handle: string): Promise<string> {
  let text = '';
  try {
    for (;;) {
      const chunk = await client.send('IO.read', { handle: handle });
      text += chunk.base64Encoded ? Buffer.from(chunk.data, 'base64').toString('utf8') : chunk.data;
      if (chunk.eof) return text;
    }
  } finally {
    await client.send('IO.close', { handle: handle });
  }
}

async function resolveScript(
  page: Page,
  client: CDPSession,
  script: ParsedScript,
  entry: Parameters<typeof mapScriptCoverage>[0],
  header?: string,
): Promise<ScriptReachEntry> {
  const url = script.url;
  try {
    const { scriptSource } = await client.send('Debugger.getScriptSource', { scriptId: script.scriptId });
    const directive = [
      ...scriptSource.matchAll(/\/\/[#@]\s*sourceMappingURL=([^\s]+)|\/\*[#@]\s*sourceMappingURL=([^\s*]+)\s*\*\//g),
    ].at(-1);
    const reference = header || script.sourceMapURL || directive?.[1] || directive?.[2];
    if (!reference) return { url, status: 'unmeasured', reason: 'source map absent' };
    const mapUrl = new URL(reference, url).href;
    const map = JSON.parse(await readResource(page, client, mapUrl));
    const files = mapScriptCoverage(entry, scriptSource, map, mapUrl.startsWith('data:') ? url : mapUrl);
    return files.length
      ? { url, status: 'mapped', files }
      : { url, status: 'unmeasured', reason: 'no mapped app sources' };
  } catch {
    return { url, status: 'unknown', reason: 'source map could not be read or resolved' };
  }
}

/** Arm BEFORE go()/navigation. Each capture/self-check needs a fresh tracker. */
export async function trackScriptReach(page: Page): Promise<ScriptReachTracker> {
  let client: CDPSession | undefined;
  let reason: string | undefined;
  let disposed = false;
  let navigated = false;
  let result: ScriptReach | undefined;
  const scripts = new Map<string, ParsedScript>();
  const headers = new Map<string, string>();
  const onResponse = (response: Response): void => {
    const values = response.headers();
    const value = values['sourcemap'] || values['x-sourcemap'];
    if (value) headers.set(response.url(), value);
  };
  const coverage = page.coverage;
  const originalStart = coverage.startJSCoverage;
  const originalStop = coverage.stopJSCoverage;
  // Playwright exposes no read-only coverage ownership query. Its public start method rejects
  // an already-enabled session before touching V8; a successful probe is immediately released.
  try {
    await originalStart.call(coverage);
    await originalStop.call(coverage);
  } catch {
    reason = 'shared V8 precise coverage';
  }
  const start: typeof originalStart = async (options) => {
    reason = 'shared V8 precise coverage';
    await client?.send('Profiler.stopPreciseCoverage').catch(() => {});
    return originalStart.call(coverage, options);
  };
  const stop: typeof originalStop = async () => {
    reason = 'shared V8 precise coverage';
    return originalStop.call(coverage);
  };
  if (!reason) {
    coverage.startJSCoverage = start;
    coverage.stopJSCoverage = stop;
    page.on('response', onResponse);
    try {
      client = await page.context().newCDPSession(page);
      client.on('Debugger.scriptParsed', (script) => {
        if (/^(https?|file|blob|webpack):/.test(script.url)) scripts.set(script.scriptId, script);
      });
      await client.send('Page.enable');
      client.on('Page.frameNavigated', ({ frame }) => {
        if (!frame.parentId) navigated = true;
      });
      await client.send('Debugger.enable');
      await client.send('Debugger.setSkipAllPauses', { skip: true });
      // Enabling the debugger also emits scripts from the previous document; they are outside this window.
      scripts.clear();
      await client.send('Profiler.enable');
      await client.send('Profiler.startPreciseCoverage', { callCount: false, detailed: true });
    } catch {
      reason = 'script coverage could not be started';
    }
  }
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    page.off('response', onResponse);
    if (coverage.startJSCoverage === start) coverage.startJSCoverage = originalStart;
    if (coverage.stopJSCoverage === stop) coverage.stopJSCoverage = originalStop;
    await client?.detach().catch(() => {});
  };
  return {
    dispose,
    stop: async () => {
      if (result) return result;
      try {
        if (reason || !client || disposed)
          return (result = unmeasuredScriptReach(reason ?? 'script coverage tracker disposed'));
        if (!navigated) return (result = unmeasuredScriptReach('navigation not observed after tracker start'));
        const coverageResult = await client.send('Profiler.takePreciseCoverage');
        if (reason) return (result = unmeasuredScriptReach(reason));
        await client.send('Profiler.stopPreciseCoverage');
        const entries: ScriptReachEntry[] = [];
        for (const entry of coverageResult.result) {
          const script = scripts.get(entry.scriptId);
          if (script) entries.push(await resolveScript(page, client, script, entry, headers.get(script.url)));
        }
        entries.sort((a, b) => {
          const x = JSON.stringify(a);
          const y = JSON.stringify(b);
          return x < y ? -1 : x > y ? 1 : 0;
        });
        if (reason) return (result = unmeasuredScriptReach(reason));
        result = { version: 1, window: 'navigation', status: 'measured', scripts: entries };
        // Keep evidence bounded well below the bundle's 16 MiB ceiling. Never silently truncate sources.
        if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024)
          result = {
            version: 1,
            window: 'navigation',
            status: 'unknown',
            reason: 'script evidence exceeds 1 MiB',
            scripts: [],
          };
      } catch {
        result = {
          version: 1,
          window: 'navigation',
          status: 'unknown',
          reason: 'script coverage could not be read',
          scripts: [],
        };
      } finally {
        await dispose();
      }
      return result;
    },
  };
}
