import {
  registerStyleProofSession,
  scriptCoverageOwnership,
  scriptCoverageMarker,
  ownershipReason,
} from './script-coverage-ownership.js';
/** Navigation-window script coverage. Reader failures are evidence gaps, never capture failures. */
import { MAP_READ_BUDGET_MS, beforeDeadline, readResource } from './script-map-resources.js';
import { storedScriptUrl } from '../script-reach-identity.js';
import { MAX_GENERATED_LENGTH } from '../script-reach-limits.js';
import { storedScriptEvidence } from '../script-reach-storage.js';
import { performance } from 'node:perf_hooks';
import type { CaptureOptions, StyleMap } from './types.js';
import type { CDPSession, Page, Response } from '@playwright/test';
import {
  mapScriptCoverage,
  ScriptEvidenceError,
  type ScriptReach,
  type ScriptReachEntry,
  type SourceSpan,
  type BinaryScriptCoverage,
} from '../script-reach.js';

type ParsedScript = {
  scriptId: string;
  url: string;
  sourceMapURL?: string;
  length?: number;
  stackTrace?: { callFrames: { scriptId: string }[] };
};
export type ScriptReachTracker = {
  stop: () => Promise<ScriptReach>;
  dispose: () => Promise<void>;
  beginMapRead?: () => Promise<void>;
};

export function unmeasuredScriptReach(reason: string): ScriptReach {
  return { version: 1, window: 'navigation', status: 'unmeasured', reason, scripts: [] };
}

function foreignCoverage(page: Page): ScriptReach | undefined {
  const ownership = scriptCoverageOwnership(page);
  if (ownership === 'exclusive') return undefined;
  return unmeasuredScriptReach(ownershipReason(ownership));
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

async function resolveScript(
  input: ScriptRead,
  script: ParsedScript,
  entry: BinaryScriptCoverage,
  deadline: number,
): Promise<ScriptReachEntry<SourceSpan>> {
  const { page, client } = input;
  const url = storedScriptUrl(script.url, input.projectRoot);
  try {
    if ((script.length ?? 0) > MAX_GENERATED_LENGTH)
      throw new ScriptEvidenceError('source mapping size limit exceeded');
    const { scriptSource } = await client.send('Debugger.getScriptSource', { scriptId: script.scriptId });
    const directive = [
      ...scriptSource.matchAll(/\/\/[#@]\s*sourceMappingURL=([^\s]+)|\/\*[#@]\s*sourceMappingURL=([^\s*]+)\s*\*\//g),
    ].at(-1);
    const reference = input.headers.get(script.url) || script.sourceMapURL || directive?.[1] || directive?.[2];
    if (!reference) return { url, status: 'unmeasured', reason: 'source map absent' };
    const mapUrl = new URL(reference, script.url).href;
    const map = JSON.parse(await readResource(page, client, mapUrl, script.url, deadline));
    const files = mapScriptCoverage(entry, scriptSource, map, mapUrl.startsWith('data:') ? script.url : mapUrl, {
      deadline,
      projectRoot: input.projectRoot,
    });
    return files.length
      ? { url, status: 'mapped', files }
      : { url, status: 'unmeasured', reason: 'no mapped app sources' };
  } catch (error) {
    return {
      url,
      status: 'unknown',
      reason: error instanceof ScriptEvidenceError ? error.message : 'source map could not be read or resolved',
    };
  }
}

type CollectedScript = BinaryScriptCoverage & { scriptId: string; url?: string };
type ScriptRead = {
  page: Page;
  client: CDPSession;
  scripts: ReadonlyMap<string, ParsedScript>;
  headers: ReadonlyMap<string, string>;
  projectRoot: string;
};

/** 1.61 omits the historical sourceURL marker; identify its utility and direct evaluations. */
async function playwrightScripts(input: ScriptRead): Promise<Set<string>> {
  const internal = new Set<string>();
  const utilities = new Set<string>();
  for (const script of input.scripts.values()) {
    if (script.url || script.stackTrace || (script.length ?? 0) > MAX_GENERATED_LENGTH) continue;
    const { scriptSource } = await input.client
      .send('Debugger.getScriptSource', { scriptId: script.scriptId })
      .catch(() => ({ scriptSource: '' }));
    if (
      scriptSource.includes('return new (module.exports.UtilityScript())(globalThis,') &&
      scriptSource.includes('var UtilityScript = class {')
    ) {
      utilities.add(script.scriptId);
      internal.add(script.scriptId);
    } else if (scriptSource === '((utilityScript, ...args) => utilityScript.evaluate(...args))')
      internal.add(script.scriptId);
  }
  for (const script of input.scripts.values())
    if (!script.url && utilities.has(script.stackTrace?.callFrames[0]?.scriptId ?? '')) internal.add(script.scriptId);
  return internal;
}

async function resolveScripts(input: ScriptRead, coverage: CollectedScript[]): Promise<ScriptReachEntry<SourceSpan>[]> {
  const deadline = performance.now() + MAP_READ_BUDGET_MS;
  const entries: ScriptReachEntry<SourceSpan>[] = [];
  const internal = await beforeDeadline(playwrightScripts(input), deadline);
  for (const entry of coverage) {
    const script = input.scripts.get(entry.scriptId);
    if (internal.has(entry.scriptId) || (script?.url ?? entry.url) === '__playwright_evaluation_script__') continue;
    if (!script || !/^(https?|file|webpack|blob):/.test(script.url)) {
      entries.push({
        url: storedScriptUrl(script?.url ?? entry.url ?? '', input.projectRoot),
        status: 'unmeasured',
        reason: 'unsupported script URL',
      });
      continue;
    }
    if (script.url.startsWith('blob:'))
      entries.push({ url: 'blob:', status: 'unmeasured', reason: 'blob script has no stable source map' });
    else if (entry.functions.some((f) => f.isBlockCoverage === false && f.ranges.some((r) => r.count > 0)))
      entries.push({
        url: storedScriptUrl(script.url, input.projectRoot),
        status: 'unknown',
        reason: 'best-effort coverage',
      });
    else if (performance.now() >= deadline)
      entries.push({
        url: storedScriptUrl(script.url, input.projectRoot),
        status: 'unknown',
        reason: 'script map-read budget exhausted',
      });
    else entries.push(await boundedResolve(input, script, entry, deadline));
  }
  return entries.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
}

async function boundedResolve(
  input: ScriptRead,
  script: ParsedScript,
  entry: CollectedScript,
  deadline: number,
): Promise<ScriptReachEntry<SourceSpan>> {
  try {
    return await beforeDeadline(resolveScript(input, script, entry, deadline), deadline);
  } catch {
    return {
      url: storedScriptUrl(script.url, input.projectRoot),
      status: 'unknown',
      reason: 'script map-read budget exhausted',
    };
  }
}

/** A foreign active profiler must never receive our session's implicit Profiler.disable. */
async function releaseClient(page: Page, client: CDPSession): Promise<ReturnType<typeof scriptCoverageOwnership>> {
  const ownership = scriptCoverageOwnership(page);
  if (ownership === 'exclusive') await client.detach().catch(() => {});
  else
    page.once('close', () => {
      void client.detach().catch(() => {});
    });
  return ownership;
}

/** Arm BEFORE go()/navigation. Each capture/self-check needs a fresh tracker. */
export async function trackScriptReach(
  page: Page,
  options: { projectRoot?: string } = {},
): Promise<ScriptReachTracker> {
  const projectRoot = options.projectRoot ?? process.cwd();
  if (page.context().browser()?.browserType().name() !== 'chromium') {
    return { stop: async () => unmeasuredScriptReach('script coverage requires Chromium'), dispose: async () => {} };
  }
  const ownership = scriptCoverageOwnership(page);
  if (ownership !== 'exclusive') {
    return {
      stop: async () => unmeasuredScriptReach(ownershipReason(ownership)),
      dispose: async () => {},
    };
  }
  const marker = scriptCoverageMarker(page);
  let client: CDPSession | undefined;
  let reason: string | undefined;
  let disposed = false;
  let navigated = false;
  let cacheDisabled = false;
  const restoreCache = async (): Promise<void> => {
    if (!cacheDisabled) return;
    cacheDisabled = false;
    await client?.send('Network.setCacheDisabled', { cacheDisabled: false }).catch(() => {});
  };
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
    reason = 'page.coverage used during capture';
    await restoreCache();
    const previous = client;
    client = undefined;
    await previous?.detach().catch(() => {});
    return originalStart.call(coverage, options);
  };
  const stop: typeof originalStop = async () => {
    reason = 'page.coverage used during capture';
    return originalStop.call(coverage);
  };
  if (!reason) {
    coverage.startJSCoverage = start;
    coverage.stopJSCoverage = stop;
    page.on('response', onResponse);
    try {
      client = registerStyleProofSession(await page.context().newCDPSession(page));
      client.on('Debugger.scriptParsed', (script) => {
        scripts.set(script.scriptId, {
          ...script,
          stackTrace: script.stackTrace ?? scripts.get(script.scriptId)?.stackTrace,
        });
      });
      const ownedClient = client;
      client.on('Debugger.paused', () => {
        void ownedClient.send('Debugger.resume').catch(() => {});
      });
      await client.send('Debugger.setSkipAllPauses', { skip: true });
      await client.send('Debugger.enable');
      await client.send('Page.enable');
      client.on('Page.frameNavigated', ({ frame }) => {
        if (!frame.parentId) navigated = true;
      });
      await client.send('Network.enable');
      await client.send('Network.setCacheDisabled', { cacheDisabled: true });
      cacheDisabled = true;
      client.on('Page.loadEventFired', () => {
        if (navigated) void restoreCache();
      });
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
      await restoreCache();
      const ownership = await releaseClient(page, client);
      client = undefined;
      if (result && ownership !== 'exclusive') result = unmeasuredScriptReach(ownershipReason(ownership));
    }
  };
  return {
    dispose,
    beginMapRead: restoreCache,
    stop: async () => {
      if (result) return result;
      try {
        if (reason || !client || disposed)
          return (result = unmeasuredScriptReach(reason ?? 'script coverage tracker disposed'));
        if (scriptCoverageMarker(page) !== marker)
          return (result = unmeasuredScriptReach('page.coverage used during capture'));
        const beforeRead = foreignCoverage(page);
        if (beforeRead) return (result = beforeRead);
        if (!navigated) return (result = unmeasuredScriptReach('navigation not observed after tracker start'));
        await client.send('Debugger.enable');
        await client.send('Debugger.setSkipAllPauses', { skip: true });
        const coverageResult = await client.send('Profiler.takePreciseCoverage');
        if (reason) return (result = unmeasuredScriptReach(reason));
        const afterRead = foreignCoverage(page);
        if (afterRead) return (result = afterRead);
        if (
          !coverageResult.result.length ||
          coverageResult.result.some((entry: CollectedScript) =>
            entry.functions.some((f) => f.ranges.some((r) => r.count > 1)),
          )
        )
          return (result = unmeasuredScriptReach('V8 precise coverage ownership changed'));
        await client.send('Profiler.stopPreciseCoverage');
        const entries = await resolveScripts({ page, client, scripts, headers, projectRoot }, coverageResult.result);
        result = reason ? unmeasuredScriptReach(reason) : storedScriptEvidence(entries);
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
