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
 * Whether a `requestfailed` error text is a cancellation (a download or a superseded
 * navigation) rather than a network error, per engine, as Playwright classifies them:
 * Chromium `net::ERR_ABORTED`, Firefox `NS_BINDING_ABORTED`, WebKit "...cancelled".
 * A missing error text counts as a cancellation, so no document commit is assumed.
 */
function isCanceledRequestFailure(errorText: string | undefined): boolean {
  if (errorText === undefined) return true;
  return errorText === 'net::ERR_ABORTED' || errorText === 'NS_BINDING_ABORTED' || errorText.includes('cancelled');
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
  // Every main-frame document request not yet committed or canceled. One slot is not
  // enough: a newer canceled navigation would hide an older one that still commits.
  const pendingMainFrameDocumentRequests = new Set<Request>();
  const epochByRequest = new Map<Request, number>();
  const onRequest = (request: Request): void => {
    epochByRequest.set(request, documentEpoch);
    // `frame()` is only safe on navigation requests (service-worker requests have none).
    if (request.isNavigationRequest() && !request.frame().parentFrame()) pendingMainFrameDocumentRequests.add(request);
  };
  const onFrameNavigated = (frame: Frame): void => {
    // Same-document navigations (pushState/hash) fire this too but load no document: the epoch holds.
    if (frame.parentFrame() || pendingMainFrameDocumentRequests.size === 0) return;
    // A commit replaces the document, so every navigation pending before it is settled.
    pendingMainFrameDocumentRequests.clear();
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
    const errorText = request.failure()?.errorText;
    // A download or a canceled navigation leaves the document alive, so a later
    // pushState must not consume its marker. Any other failure (ERR_EMPTY_RESPONSE,
    // ERR_CONNECTION_REFUSED) commits an error page, a new document: keep the marker.
    if (isCanceledRequestFailure(errorText)) pendingMainFrameDocumentRequests.delete(request);
    if (terminalEventSources.has(request)) return;
    record(request, errorText ?? 'request failed');
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
