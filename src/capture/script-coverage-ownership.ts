import type { Page, CDPSession } from '@playwright/test';

const styleProofSessions = new WeakSet<object>();

/** CSS-only StyleProof controllers do not own V8 precise coverage. */
export function registerStyleProofSession(client: CDPSession): CDPSession {
  styleProofSessions.add(client);
  return client;
}

type CoveragePeer = { _type?: string; _parent?: unknown };
type CoverageState = { _jsCoverage?: { _enabled?: boolean } };
type PageImplementation = {
  coverage?: CoverageState;
  delegate?: { _coverage?: CoverageState };
  _delegate?: { _coverage?: CoverageState };
};
type CoverageConnection = { _objects?: Map<string, CoveragePeer>; toImpl?: (page: Page) => PageImplementation };

/**
 * CDP has no read-only precise-coverage ownership query. Playwright's in-process
 * bridge exposes its coverage flag and client-controller inventory without a
 * protocol mutation. If that bridge changes or is unavailable, refuse ownership.
 * Any external CDP controller is conservatively considered a potential profiler.
 */
export function scriptCoverageOwnership(page: Page): 'exclusive' | 'shared' | 'unknown' {
  const connection = (page as unknown as { _connection?: CoverageConnection })._connection;
  try {
    const implementation = connection?.toImpl?.(page);
    const state =
      implementation?.coverage ?? implementation?.delegate?._coverage ?? implementation?._delegate?._coverage;
    const enabled = state?._jsCoverage?._enabled;
    if (typeof enabled !== 'boolean' || !(connection?._objects instanceof Map)) return 'unknown';
    if (enabled) return 'shared';
    const context = page.context();
    for (const peer of connection._objects.values()) {
      if (peer._type === 'CDPSession' && peer._parent === context && !styleProofSessions.has(peer)) return 'shared';
    }
    return 'exclusive';
  } catch {
    return 'unknown';
  }
}
