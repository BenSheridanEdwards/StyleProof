// Stall deadline for a browser run: Chrome can stay alive yet stop answering (a frozen or starved
// renderer, a page script stuck in a loop), and page.evaluate / setViewportSize have no timeout, so
// the run would wait forever. Progress is any Playwright call the browser answered; a run with none
// for the deadline fails closed. A long exhaustive crawl keeps answering, so it is never capped.
import type { Logger } from '@playwright/test';
import { realNow } from './spec-clock.js';

/** Default no-progress deadline: 5 minutes. A healthy run answers a call every second or so. */
export const DEFAULT_STALL_TIMEOUT_MS = 300_000;

/** setTimeout's largest delay; a longer one fires after 1 ms, so longer deadlines re-check at this cap. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export class BrowserStallError extends Error {
  constructor(timeoutMs: number) {
    super(`the browser stopped responding: no progress for ${timeoutMs / 1000}s`);
    this.name = 'BrowserStallError';
  }
}

export type BrowserProgressWatch = {
  /** Pass to `chromium.launch({ logger })`: every browser, context and page call reports through it. */
  logger: Logger;
  /** Settle as `work` does, or reject with BrowserStallError once no call has succeeded for the deadline. */
  race: <ResultType>(work: Promise<ResultType>) => Promise<ResultType>;
};

/** Watch a launched browser for progress. Only `<= api succeeded` counts: a failed call can be a
 *  timeout that fired because the browser stopped answering. */
export function watchBrowserProgress(timeoutMs: number): BrowserProgressWatch {
  let lastProgressAt = realNow();
  const logger: Logger = {
    isEnabled: (name) => name === 'api',
    log: (_name, _severity, message) => {
      if (typeof message === 'string' && message.endsWith(' succeeded')) lastProgressAt = realNow();
    },
  };
  const race = async <ResultType>(work: Promise<ResultType>): Promise<ResultType> => {
    let timer: NodeJS.Timeout | undefined;
    // Playwright work is not abortable: once the stall wins, a later rejection is detached, never unhandled.
    work.catch(() => {});
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          const check = (): void => {
            const idleMs = realNow() - lastProgressAt;
            if (idleMs >= timeoutMs) reject(new BrowserStallError(timeoutMs));
            else timer = setTimeout(check, Math.min(timeoutMs - idleMs, MAX_TIMER_MS));
          };
          check();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  return { logger, race };
}
