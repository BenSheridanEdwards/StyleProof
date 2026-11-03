import { registerStyleProofSession, scriptCoverageOwnership } from './script-coverage-ownership.js';
/** Navigation-window script coverage. Reader failures are evidence gaps, never capture failures. */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import type { CaptureOptions, StyleMap } from './types.js';
import type { CDPSession, Page, Response } from '@playwright/test';
import {
  mapScriptCoverage,
  type ScriptReach,
  type ScriptReachEntry,
  type BinaryScriptCoverage,
} from '../script-reach.js';

type ParsedScript = { scriptId: string; url: string; sourceMapURL?: string };
export type ScriptReachTracker = {
  stop: () => Promise<ScriptReach>;
  dispose: () => Promise<void>;
};

export function unmeasuredScriptReach(reason: string): ScriptReach {
  return { version: 1, window: 'navigation', status: 'unmeasured', reason, scripts: [] };
}

function foreignCoverage(page: Page): ScriptReach | undefined {
  const ownership = scriptCoverageOwnership(page);
  if (ownership === 'exclusive') return undefined;
  return unmeasuredScriptReach(
    ownership === 'shared' ? 'shared V8 precise coverage' : 'script coverage ownership unavailable',
  );
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

const MAP_READ_BUDGET_MS = 1500;
const RESOURCE_TIMEOUT_MS = 500;

class MapReadTimeout extends Error {}

async function beforeDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new MapReadTimeout('script map-read budget exhausted')),
          Math.max(0, deadline - performance.now()),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readResource(page: Page, client: CDPSession, url: string, deadline: number): Promise<string> {
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',');
    if (comma < 0) throw new Error('invalid data URL');
    const payload = decodeURIComponent(url.slice(comma + 1));
    return /;base64$/i.test(url.slice(0, comma)) ? Buffer.from(payload, 'base64').toString('utf8') : payload;
  }
  if (url.startsWith('file:')) return beforeDeadline(readFile(fileURLToPath(url), 'utf8'), deadline);
  // These requests use page credentials and Playwright/HAR routing; see the capture reference.
  try {
    return await beforeDeadline(
      page.evaluate(
        async ({ address, timeout }) => {
          const response = await fetch(address, { credentials: 'include', signal: AbortSignal.timeout(timeout) });
          if (!response.ok) throw new Error('source map request failed');
          return response.text();
        },
        { address: url, timeout: Math.max(1, Math.min(RESOURCE_TIMEOUT_MS, Math.floor(deadline - performance.now()))) },
      ),
      deadline,
    );
  } catch {
    if (performance.now() >= deadline) throw new MapReadTimeout();
    return beforeDeadline(readCdpResource(client, url), Math.min(deadline, performance.now() + RESOURCE_TIMEOUT_MS));
  }
}

async function readCdpResource(client: CDPSession, url: string): Promise<string> {
  const { frameTree } = await client.send('Page.getFrameTree');
  const { resource } = await client.send('Network.loadNetworkResource', {
    frameId: frameTree.frame.id,
    url,
    options: { disableCache: false, includeCredentials: true },
  });
  if (!resource.success || !resource.stream) throw new Error('source map request failed');
  const chunks: Buffer[] = [];
  try {
    for (;;) {
      const chunk = await client.send('IO.read', { handle: resource.stream });
      chunks.push(Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8'));
      if (chunk.eof) return Buffer.concat(chunks).toString('utf8');
    }
  } finally {
    await client.send('IO.close', { handle: resource.stream }).catch(() => {});
  }
}

async function resolveScript(
  page: Page,
  client: CDPSession,
  script: ParsedScript,
  entry: Parameters<typeof mapScriptCoverage>[0],
  header: string | undefined,
  deadline: number,
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
    const map = JSON.parse(await readResource(page, client, mapUrl, deadline));
    const files = mapScriptCoverage(entry, scriptSource, map, mapUrl.startsWith('data:') ? url : mapUrl);
    return files.length
      ? { url, status: 'mapped', files }
      : { url, status: 'unmeasured', reason: 'no mapped app sources' };
  } catch (error) {
    return {
      url,
      status: 'unknown',
      reason:
        error instanceof MapReadTimeout
          ? 'script map-read budget exhausted'
          : 'source map could not be read or resolved',
    };
  }
}

type CollectedScript = BinaryScriptCoverage & { scriptId: string };
type ScriptRead = {
  page: Page;
  client: CDPSession;
  scripts: ReadonlyMap<string, ParsedScript>;
  headers: ReadonlyMap<string, string>;
};

function validCoverage(entries: CollectedScript[], scripts: ReadonlyMap<string, ParsedScript>): boolean {
  const appEntries = entries.filter((entry) => scripts.has(entry.scriptId));
  const bestEffort = appEntries.some((entry) =>
    entry.functions.some((f) => f.isBlockCoverage === false && f.ranges.some((r) => r.count > 0)),
  );
  const callCounts = entries.some((entry) => entry.functions.some((f) => f.ranges.some((r) => r.count > 1)));
  return entries.length > 0 && (!scripts.size || appEntries.length > 0) && !bestEffort && !callCounts;
}

async function resolveScripts(input: ScriptRead, coverage: CollectedScript[]): Promise<ScriptReachEntry[]> {
  const deadline = performance.now() + MAP_READ_BUDGET_MS;
  const entries: ScriptReachEntry[] = [];
  for (const entry of coverage) {
    const script = input.scripts.get(entry.scriptId);
    if (!script) continue;
    if (performance.now() >= deadline)
      entries.push({ url: script.url, status: 'unknown', reason: 'script map-read budget exhausted' });
    else entries.push(await boundedResolve(input, script, entry, deadline));
  }
  return entries.sort((a, b) => {
    const x = JSON.stringify(a),
      y = JSON.stringify(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

async function boundedResolve(
  input: ScriptRead,
  script: ParsedScript,
  entry: CollectedScript,
  deadline: number,
): Promise<ScriptReachEntry> {
  try {
    return await beforeDeadline(
      resolveScript(input.page, input.client, script, entry, input.headers.get(script.url), deadline),
      deadline,
    );
  } catch {
    return { url: script.url, status: 'unknown', reason: 'script map-read budget exhausted' };
  }
}

function boundedEvidence(scripts: ScriptReachEntry[]): ScriptReach {
  const evidence: ScriptReach = { version: 1, window: 'navigation', status: 'measured', scripts };
  return Buffer.byteLength(JSON.stringify(evidence)) > 1024 * 1024
    ? { version: 1, window: 'navigation', status: 'unknown', reason: 'script evidence exceeds 1 MiB', scripts: [] }
    : evidence;
}

/** A foreign active profiler must never receive our session's implicit Profiler.disable. */
async function releaseClient(page: Page, client: CDPSession): Promise<'exclusive' | 'shared' | 'unknown'> {
  const ownership = scriptCoverageOwnership(page);
  if (ownership === 'exclusive') await client.detach().catch(() => {});
  else
    page.once('close', () => {
      void client.detach().catch(() => {});
    });
  return ownership;
}

/** Arm BEFORE go()/navigation. Each capture/self-check needs a fresh tracker. */
export async function trackScriptReach(page: Page): Promise<ScriptReachTracker> {
  if (page.context().browser()?.browserType().name() !== 'chromium') {
    return { stop: async () => unmeasuredScriptReach('script coverage requires Chromium'), dispose: async () => {} };
  }
  const ownership = scriptCoverageOwnership(page);
  if (ownership !== 'exclusive') {
    return {
      stop: async () =>
        unmeasuredScriptReach(
          ownership === 'shared' ? 'shared V8 precise coverage' : 'script coverage ownership unavailable',
        ),
      dispose: async () => {},
    };
  }
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
  const start: typeof originalStart = async (options) => {
    reason = 'shared V8 precise coverage';
    const previous = client;
    client = undefined;
    await previous?.detach().catch(() => {});
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
      client = registerStyleProofSession(await page.context().newCDPSession(page));
      client.on('Debugger.scriptParsed', (script) => {
        if (/^(https?|file|webpack):/.test(script.url)) scripts.set(script.scriptId, script);
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
    if (client) {
      const ownership = await releaseClient(page, client);
      client = undefined;
      if (result && ownership !== 'exclusive')
        result = unmeasuredScriptReach(
          ownership === 'shared' ? 'shared V8 precise coverage' : 'script coverage ownership unavailable',
        );
    }
  };
  return {
    dispose,
    stop: async () => {
      if (result) return result;
      try {
        if (reason || !client || disposed)
          return (result = unmeasuredScriptReach(reason ?? 'script coverage tracker disposed'));
        const beforeRead = foreignCoverage(page);
        if (beforeRead) return (result = beforeRead);
        if (!navigated) return (result = unmeasuredScriptReach('navigation not observed after tracker start'));
        const coverageResult = await client.send('Profiler.takePreciseCoverage');
        if (reason) return (result = unmeasuredScriptReach(reason));
        const afterRead = foreignCoverage(page);
        if (afterRead) return (result = afterRead);
        if (!validCoverage(coverageResult.result, scripts))
          return (result = unmeasuredScriptReach('shared V8 precise coverage'));
        await client.send('Profiler.stopPreciseCoverage');
        const entries = await resolveScripts({ page, client, scripts, headers }, coverageResult.result);
        result = reason ? unmeasuredScriptReach(reason) : boundedEvidence(entries);
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
