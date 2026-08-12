/**
 * Pre-capture verification that the pinned Playwright browser build actually
 * exists on the host. A re-provisioned runner can come up with an empty
 * ms-playwright cache; without this preflight every capture dies minutes into
 * the run at `browserType.launch: Executable doesn't exist at …`. The driver
 * (bin/styleproof-ci.mjs) runs this BEFORE the first capture, self-heals a
 * missing build with one `playwright install`, and otherwise fails
 * immediately with the exact remedy command and the missing revision name.
 *
 * Everything decidable without side effects lives here so it is
 * unit-testable; the driver owns process work (spawning `playwright install`)
 * and logging.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/** The browsers StyleProof captures can launch. Chromium is always required
 *  (the capture runner and crawl CLIs launch it); webkit only when the
 *  consumer's capture Playwright config asks for it. */
export type PreflightBrowserName = 'chromium' | 'webkit';

export type BrowserExecutableResolution =
  { kind: 'resolved'; executablePath: string } | { kind: 'unresolvable'; reason: string };

export type BrowserPreflightVerdict =
  | {
      status: 'verified';
      browserName: PreflightBrowserName;
      executablePath: string;
      revisionDirectory: string;
    }
  | {
      status: 'missing';
      browserName: PreflightBrowserName;
      executablePath: string;
      revisionDirectory: string;
      remedyCommand: string;
      message: string;
    };

/** The capture-side Playwright configs, most specific first: styleproof-map
 *  prefers the dedicated `playwright.styleproof.config.ts` when it exists and
 *  otherwise lets Playwright pick up the repo's own config. */
const CAPTURE_PLAYWRIGHT_CONFIG_FILENAMES = [
  'playwright.styleproof.config.ts',
  'playwright.config.ts',
  'playwright.config.mts',
  'playwright.config.cts',
  'playwright.config.js',
  'playwright.config.mjs',
  'playwright.config.cjs',
];

/** Text of the capture Playwright config governing `cwd`, or undefined when
 *  no config file exists there. */
export function readCapturePlaywrightConfigText(cwd: string): string | undefined {
  for (const configFilename of CAPTURE_PLAYWRIGHT_CONFIG_FILENAMES) {
    const configPath = path.join(cwd, configFilename);
    if (fs.existsSync(configPath)) return fs.readFileSync(configPath, 'utf8');
  }
  return undefined;
}

/**
 * The browsers the preflight must verify, from the capture config's text.
 * Chromium always; webkit is added when the config mentions it (a deliberate
 * token-level detection — executing the consumer's config here would launch
 * arbitrary code before capture). A webkit project referenced only through a
 * device descriptor (e.g. `devices['Desktop Safari']` in a file that never
 * says "webkit") is not detected; such consumers keep installing webkit in
 * their own workflow, and the preflight says which browsers it checked.
 */
export function browsersRequiredByCaptureConfig(configText: string | undefined): PreflightBrowserName[] {
  if (configText !== undefined && /\bwebkit\b/i.test(configText)) return ['chromium', 'webkit'];
  return ['chromium'];
}

type PlaywrightBrowserTypeLike = { executablePath: () => string };

function errorMessageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function browserTypeFromModule(
  playwrightModule: unknown,
  browserName: PreflightBrowserName,
): PlaywrightBrowserTypeLike | undefined {
  if (typeof playwrightModule !== 'object' || playwrightModule === null) return undefined;
  const candidate = (playwrightModule as Record<string, unknown>)[browserName];
  if (typeof candidate !== 'object' || candidate === null) return undefined;
  const executablePath = (candidate as Record<string, unknown>).executablePath;
  if (typeof executablePath !== 'function') return undefined;
  return candidate as PlaywrightBrowserTypeLike;
}

/**
 * Resolve where the consumer's own pinned Playwright expects `browserName`'s
 * executable, via the documented `browserType.executablePath()` API — never a
 * hardcoded ms-playwright cache layout. Resolution walks the consumer's
 * dependency tree (`playwright-core` first, `@playwright/test` as the
 * fallback for isolated installs), so the revision matches the release the
 * capture will actually launch. Unresolvable is a soft verdict: the driver
 * falls back to an unconditional `playwright install` rather than failing a
 * consumer whose Playwright lives outside its node_modules.
 */
/** One resolution attempt against one Playwright package. */
function browserExecutableFromModule(
  consumerRequire: NodeJS.Require,
  playwrightModuleName: string,
  browserName: PreflightBrowserName,
): { executablePath: string } | { failure: string } {
  let playwrightModule: unknown;
  try {
    playwrightModule = consumerRequire(playwrightModuleName);
  } catch (error) {
    return { failure: `${playwrightModuleName}: ${errorMessageText(error)}` };
  }
  const browserType = browserTypeFromModule(playwrightModule, browserName);
  if (!browserType) {
    return { failure: `${playwrightModuleName}: no ${browserName} browser type with executablePath()` };
  }
  try {
    const executablePath = browserType.executablePath();
    if (typeof executablePath === 'string' && executablePath) return { executablePath };
    return { failure: `${playwrightModuleName}: executablePath() returned nothing for ${browserName}` };
  } catch (error) {
    return { failure: `${playwrightModuleName}: ${errorMessageText(error)}` };
  }
}

export function resolveBrowserExecutablePath(
  cwd: string,
  browserName: PreflightBrowserName,
): BrowserExecutableResolution {
  const consumerRequire = createRequire(path.join(path.resolve(cwd), 'package.json'));
  const resolutionFailures: string[] = [];
  for (const playwrightModuleName of ['playwright-core', '@playwright/test']) {
    const attempt = browserExecutableFromModule(consumerRequire, playwrightModuleName, browserName);
    if ('executablePath' in attempt) return { kind: 'resolved', executablePath: attempt.executablePath };
    resolutionFailures.push(attempt.failure);
  }
  return { kind: 'unresolvable', reason: resolutionFailures.join('; ') };
}

/** The browser-build directory name a Playwright executable path pins (e.g.
 *  `chromium_headless_shell-1234`, `webkit-2092`) — the revision a remedy
 *  must name. Falls back to the executable's basename when no path segment
 *  looks like a revision directory. */
export function revisionDirectoryFromExecutablePath(executablePath: string): string {
  const segments = executablePath.split(/[\\/]/);
  for (let segmentIndex = segments.length - 1; segmentIndex >= 0; segmentIndex--) {
    if (/^[a-z][a-z_]*-\d+$/.test(segments[segmentIndex])) return segments[segmentIndex];
  }
  return path.basename(executablePath);
}

/** The exact command a human runs on the affected host to install the
 *  missing browser build(s). */
export function playwrightInstallRemedyCommand(browserNames: PreflightBrowserName[]): string {
  return `npx playwright install ${browserNames.join(' ')}`;
}

/**
 * The preflight verdict for one browser: `verified` when the executable the
 * pinned Playwright release expects actually exists, otherwise `missing` with
 * the exact remedy command and the missing revision name. `executableExists`
 * defaults to a real filesystem check and is injectable for tests.
 */
export function evaluateBrowserPreflight(
  browserName: PreflightBrowserName,
  executablePath: string,
  executableExists: boolean = fs.existsSync(executablePath),
): BrowserPreflightVerdict {
  const revisionDirectory = revisionDirectoryFromExecutablePath(executablePath);
  if (executableExists) return { status: 'verified', browserName, executablePath, revisionDirectory };
  const remedyCommand = playwrightInstallRemedyCommand([browserName]);
  return {
    status: 'missing',
    browserName,
    executablePath,
    revisionDirectory,
    remedyCommand,
    message:
      `the pinned ${browserName} browser build ${revisionDirectory} is missing — ` +
      `expected executable at ${executablePath}. ` +
      `Next: run \`${remedyCommand}\` on this host, then re-run.`,
  };
}
