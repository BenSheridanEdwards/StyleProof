import type { Frame, Page, Request, Response } from '@playwright/test';
import { endpointOf, residueKey, type DataResidueEntry } from '../data-residue.js';
import { urlMatcher } from './url-glob.js';

/**
 * Track in-flight DATA requests so the network-aware settle waits for late content to
 * ARRIVE. Long-lived streams (EventSource/WebSocket) never finish, so they are excluded.
 * Attach BEFORE navigation to count the page's own load fetches.
 */
export function trackInflightRequests(page: Page): { pending: () => number; dispose: () => void } {
  const inflight = new Set<Request>();
  const isStream = (r: Request): boolean => ['eventsource', 'websocket'].includes(r.resourceType());
  const onStart = (r: Request): void => {
    if (!isStream(r)) inflight.add(r);
  };
  const onEnd = (r: Request): void => {
    inflight.delete(r);
  };
  page.on('request', onStart);
  page.on('requestfinished', onEnd);
  page.on('requestfailed', onEnd);
  return {
    pending: (): number => inflight.size,
    dispose: (): void => {
      page.off('request', onStart);
      page.off('requestfinished', onEnd);
      page.off('requestfailed', onEnd);
    },
  };
}

/**
 * Watch the data boundary (`url`, the `replayUrl` glob) for requests that FAIL during
 * capture (network error or 4xx/5xx): the captured state then renders that endpoint's
 * FALLBACK branch. Passive listeners, never a route, so a surface's own routes still win.
 * Only failures are recorded — a live 2xx is legitimate in recording mode.
 *
 * Attribution: the walk shares one page across surfaces, so a failure is charged to
 * THIS surface only when its `request` event fired while this watcher was armed and no
 * cross-document main-frame commit has replaced that document since (epoch check).
 */
export function trackDataResidue(
  page: Page,
  url: string,
  surface: string,
): { residue: () => DataResidueEntry[]; dispose: () => void } {
  // Keyed per request so EventSource's `response(204)` + `requestfailed(ERR_ABORTED)`
  // pair cancels only that false failure.
  const byRequest = new Map<Request, DataResidueEntry>();
  const terminalEventSources = new WeakSet<Request>();
  const inBoundary = urlMatcher(url);
  let documentEpoch = 0;
  let mainFrameDocumentRequestSeen = false;
  const epochByRequest = new Map<Request, number>();
  const onRequest = (request: Request): void => {
    epochByRequest.set(request, documentEpoch);
    // `frame()` is only safe on navigation requests (service-worker requests have none).
    if (request.isNavigationRequest() && !request.frame().parentFrame()) mainFrameDocumentRequestSeen = true;
  };
  const onFrameNavigated = (frame: Frame): void => {
    // Same-document navigations (pushState/hash) fire this too but load no document: the epoch holds.
    if (frame.parentFrame() || !mainFrameDocumentRequestSeen) return;
    mainFrameDocumentRequestSeen = false;
    documentEpoch += 1;
  };
  const record = (request: Request, reason: string): void => {
    if (epochByRequest.get(request) !== documentEpoch) return;
    if (!inBoundary(request.url())) return;
    const endpoint = endpointOf(request.url());
    const key = residueKey(surface, endpoint);
    if (!byRequest.has(request)) byRequest.set(request, { key, surface, endpoint, reason });
  };
  const onFailed = (request: Request): void => {
    if (terminalEventSources.has(request)) return;
    record(request, request.failure()?.errorText ?? 'request failed');
  };
  const onResponse = (resp: Response): void => {
    const request = resp.request();
    if (resp.status() === 204 && request.resourceType() === 'eventsource') {
      terminalEventSources.add(request);
      byRequest.delete(request); // independent of Playwright's response/requestfailed order
      return;
    }
    if (resp.status() >= 400) record(request, `HTTP ${resp.status()}`);
  };
  page.on('request', onRequest);
  page.on('framenavigated', onFrameNavigated);
  page.on('requestfailed', onFailed);
  page.on('response', onResponse);
  return {
    residue: (): DataResidueEntry[] => {
      const byKey = new Map<string, DataResidueEntry>();
      for (const entry of byRequest.values()) if (!byKey.has(entry.key)) byKey.set(entry.key, entry);
      return Array.from(byKey.values()).sort((a, b) => a.key.localeCompare(b.key));
    },
    dispose: (): void => {
      page.off('request', onRequest);
      page.off('framenavigated', onFrameNavigated);
      page.off('requestfailed', onFailed);
      page.off('response', onResponse);
    },
  };
}
