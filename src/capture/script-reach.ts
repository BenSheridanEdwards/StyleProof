import {
  registerStyleProofSession,
  scriptCoverageOwnership,
  scriptCoverageMarker,
  ownershipReason,
} from './script-coverage-ownership.js';
/** Navigation-window script coverage. Reader failures are evidence gaps, never capture failures. */
import { MAP_READ_BUDGET_MS, beforeDeadline, readResource } from './script-map-resources.js';
import { applyMediaState } from '../media-states.js';
import { sourceIdentities, storedScriptUrl } from '../script-reach-identity.js';
import { STYLEPROOF_SCRIPT_URL } from './script-evaluation.js';
import { resolveScriptProjectRoot, scriptProjectRootPrefix } from './script-project-root.js';
import { MAX_GENERATED_LENGTH, MAX_SCRIPTS, MAX_SCRIPT_IDENTIFICATIONS } from '../script-reach-limits.js';
import { storedScriptEvidence } from '../script-reach-storage.js';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import type { CaptureOptions, MediaState, StyleMap } from './types.js';
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
  hash?: string;
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
    const resolvedMapUrl = mapUrl.startsWith('data:') ? script.url : mapUrl;
    const files = mapScriptCoverage(entry, scriptSource, map, resolvedMapUrl, {
      deadline,
      projectRoot: input.projectRoot,
    });
    if (files.length) return { url, status: 'mapped', files };
    const nonAppSourcesOnly =
      map.sources.length > 0 &&
      map.sources.every((source: string | null) => typeof source === 'string' && source.length > 0) &&
      sourceIdentities(map, resolvedMapUrl, input.projectRoot).every((source) => source === undefined);
    return {
      url,
      status: 'unmeasured',
      reason: 'no mapped app sources',
      ...(nonAppSourcesOnly ? { nonAppSourcesOnly: true as const } : {}),
    };
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

const PLAYWRIGHT_INIT_PREFIX = '(() => {\n      ';
const PLAYWRIGHT_INIT_SUFFIX = '\n    })();';

/** Clock installation evaluates this expression directly and as an init-script body. */
function playwrightClockSource(source: string): string | undefined {
  const body =
    source.startsWith(PLAYWRIGHT_INIT_PREFIX + '(() => {') && source.endsWith(PLAYWRIGHT_INIT_SUFFIX)
      ? source.slice(PLAYWRIGHT_INIT_PREFIX.length, -PLAYWRIGHT_INIT_SUFFIX.length)
      : source;

  return body.startsWith('(() => {\n      const module = {};\n      \nvar __commonJS =') &&
    body.includes('var ClockController = class {') &&
    body.endsWith(
      '\n      if (!globalThis.__pwClock)\n        globalThis.__pwClock = (module.exports.inject())(globalThis, "chromium");\n    })();',
    )
    ? body
    : undefined;
}

/** Match 1.61's complete init wrappers, never an arbitrary app init/eval body. */
function playwrightInitScript(source: string): boolean {
  if (!source.startsWith(PLAYWRIGHT_INIT_PREFIX) || !source.endsWith(PLAYWRIGHT_INIT_SUFFIX)) return false;
  const body = source.slice(PLAYWRIGHT_INIT_PREFIX.length, -PLAYWRIGHT_INIT_SUFFIX.length);

  if (/^globalThis\['__playwright__binding__controller__'\]\.addBinding\("(?:[^"\\\r\n]|\\.)*"\)$/.test(body))
    return true;

  if (
    /^globalThis\.__pwClock\.controller\.log\('(install|setFixedTime|setSystemTime|pauseAt|runFor|fastForward)', -?\d+(?:\.\d+)?(?:e[+-]?\d+)?, -?\d+(?:\.\d+)?(?:e[+-]?\d+)?\)$/.test(
      body,
    ) ||
    /^globalThis\.__pwClock\.controller\.log\('resume', -?\d+(?:\.\d+)?(?:e[+-]?\d+)?\)$/.test(body)
  )
    return true;

  return (
    body.startsWith('\n      (() => {\n        const module = {};\n        \nvar __commonJS =') &&
    body.includes('var BindingsController = class {') &&
    body.endsWith(
      "\n        const property = '__playwright__binding__controller__';\n        if (!globalThis[property])\n          globalThis[property] = new (module.exports.BindingsController())(globalThis, '__playwright__binding__');\n      })();\n    ",
    )
  );
}

function injectedScriptKind(scriptSource: string): 'utility' | 'internal' | undefined {
  if (
    ['UtilityScript', 'InjectedScript'].some(
      (kind) =>
        scriptSource.includes(`return new (module.exports.${kind}())(globalThis,`) &&
        scriptSource.includes(`var ${kind} = class {`),
    )
  )
    return 'utility';

  if (
    scriptSource === '((utilityScript, ...args) => utilityScript.evaluate(...args))' ||
    playwrightClockSource(scriptSource) !== undefined ||
    playwrightInitScript(scriptSource)
  )
    return 'internal';

  return undefined;
}

/**
 * 1.61 omits the historical sourceURL marker on init wrappers and direct evaluations with stacks.
 * Init scripts in frames created by capture or app code carry that caller's stack.
 */
async function playwrightScripts(input: ScriptRead): Promise<Set<string>> {
  const internal = new Set<string>();
  const utilities = new Set<string>();
  const knownSources = new Map<string, 'utility' | 'internal'>();

  for (const script of input.scripts.values()) {
    if (script.url || (script.length ?? 0) > MAX_GENERATED_LENGTH) continue;

    const { scriptSource } = await input.client
      .send('Debugger.getScriptSource', { scriptId: script.scriptId })
      .catch(() => ({ scriptSource: '' }));

    const kind = injectedScriptKind(scriptSource);

    if (!kind) continue;
    internal.add(script.scriptId);

    if (kind === 'utility') utilities.add(script.scriptId);

    if (script.hash) knownSources.set(script.hash, kind);

    const clockSource = playwrightClockSource(scriptSource);

    if (clockSource) {
      knownSources.set(createHash('sha256').update(clockSource).digest('hex'), 'internal');
      knownSources.set(
        createHash('sha256').update(`${PLAYWRIGHT_INIT_PREFIX}${clockSource}${PLAYWRIGHT_INIT_SUFFIX}`).digest('hex'),
        'internal',
      );
    }
  }

  // Discarded contexts can leave timer coverage after getScriptSource stops working.
  // Clock hashes cover its exact direct and init forms; app hashes are never learned.
  input.scripts.forEach((script) => {
    if (script.url || !script.hash || !knownSources.has(script.hash)) return;
    internal.add(script.scriptId);

    if (knownSources.get(script.hash) === 'utility') utilities.add(script.scriptId);
  });

  input.scripts.forEach((script) => {
    if (!script.url && utilities.has(script.stackTrace?.callFrames[0]?.scriptId ?? '')) internal.add(script.scriptId);
  });

  return internal;
}

async function resolveScripts(input: ScriptRead, coverage: CollectedScript[]): Promise<ScriptReachEntry<SourceSpan>[]> {
  if (coverage.length > MAX_SCRIPT_IDENTIFICATIONS || input.scripts.size > MAX_SCRIPT_IDENTIFICATIONS)
    return [
      {
        url: '<script identification limit>',
        status: 'unknown',
        reason: `script identification count exceeds ${MAX_SCRIPT_IDENTIFICATIONS}`,
      },
    ];
  const deadline = performance.now() + MAP_READ_BUDGET_MS;
  const entries: ScriptReachEntry<SourceSpan>[] = [];
  const internal = await beforeDeadline(playwrightScripts(input), deadline);
  const appCoverage = coverage.filter((entry) => {
    const url = input.scripts.get(entry.scriptId)?.url ?? entry.url;
    return !internal.has(entry.scriptId) && url !== '__playwright_evaluation_script__' && url !== STYLEPROOF_SCRIPT_URL;
  });
  if (appCoverage.length > MAX_SCRIPTS)
    return [{ url: '<script limit>', status: 'unknown', reason: `script count exceeds ${MAX_SCRIPTS}` }];
  for (const entry of appCoverage)
    entries.push(await resolveCoverageEntry(input, input.scripts.get(entry.scriptId), entry, deadline));
  return entries.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
}

async function resolveCoverageEntry(
  input: ScriptRead,
  script: ParsedScript | undefined,
  entry: CollectedScript,
  deadline: number,
): Promise<ScriptReachEntry<SourceSpan>> {
  const url = storedScriptUrl(script?.url ?? entry.url ?? '', input.projectRoot);
  if (!script || !/^(https?|file|webpack|blob):/.test(script.url))
    return { url, status: 'unmeasured', reason: 'unsupported script URL' };
  if (script.url.startsWith('blob:'))
    return { url, status: 'unmeasured', reason: 'blob script has no stable source map' };
  if (entry.functions.some((f) => f.isBlockCoverage === false && f.ranges.some((r) => r.count > 0)))
    return { url, status: 'unknown', reason: 'best-effort coverage' };
  if (performance.now() >= deadline) return { url, status: 'unknown', reason: 'script map-read budget exhausted' };
  return boundedResolve(input, script, entry, deadline);
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
  options: { projectRoot?: string; projectRootPrefix?: string | null; mediaState?: MediaState } = {},
): Promise<ScriptReachTracker> {
  const projectRoot = options.projectRoot ?? resolveScriptProjectRoot();
  const projectRootPrefix =
    options.projectRootPrefix === undefined
      ? scriptProjectRootPrefix(projectRoot)
      : (options.projectRootPrefix ?? undefined);
  const withRoot = (evidence: ScriptReach): ScriptReach => ({
    ...evidence,
    ...(projectRootPrefix !== undefined
      ? { projectRootPrefix }
      : { projectRootIssue: 'project-root prefix unavailable: git lookup failed or timed out; recapture scriptReach' }),
  });
  if (page.context().browser()?.browserType().name() !== 'chromium') {
    return {
      stop: async () => withRoot(unmeasuredScriptReach('script coverage requires Chromium')),
      dispose: async () => {},
    };
  }
  const ownership = scriptCoverageOwnership(page);
  if (ownership !== 'exclusive') {
    return {
      stop: async () => withRoot(unmeasuredScriptReach(ownershipReason(ownership))),
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
      if (options.mediaState) await applyMediaState(page, options.mediaState, client);
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
  const read = async (): Promise<ScriptReach> => {
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
      result = reason ? unmeasuredScriptReach(reason) : storedScriptEvidence(entries, projectRootPrefix);
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
  };
  return {
    dispose,
    beginMapRead: restoreCache,
    stop: async () => withRoot(await read()),
  };
}
