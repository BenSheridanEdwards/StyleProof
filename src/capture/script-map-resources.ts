import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import type { Page, CDPSession } from '@playwright/test';
import { ScriptEvidenceError } from '../script-reach.js';

const MAX_MAP_BYTES = 8 * 1024 * 1024;
function checkedMapText(text: string): string {
  if (Buffer.byteLength(text) > MAX_MAP_BYTES) throw new ScriptEvidenceError('source map input size limit exceeded');
  return text;
}

export async function readFileSourceMap(url: string, scriptUrl: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  if (new URL(scriptUrl).protocol !== 'file:')
    throw new ScriptEvidenceError('file source map refused for non-file script');
  const path = fileURLToPath(url);
  const info = await stat(path);
  if (!info.isFile()) throw new ScriptEvidenceError('source map must be a regular file');
  if (info.size > MAX_MAP_BYTES) throw new ScriptEvidenceError('source map input size limit exceeded');
  return checkedMapText(await readFile(path, { encoding: 'utf8', signal }));
}

function routingActive(page: Page): boolean {
  type Routing = { _routes?: unknown[]; _harRouters?: Map<unknown, unknown> };
  return [page, page.context()].some((owner) => {
    const routing = owner as unknown as Routing;
    return Boolean(routing._routes?.length || routing._harRouters?.size);
  });
}
export const MAP_READ_BUDGET_MS = 1500;
const RESOURCE_TIMEOUT_MS = 500;

export class MapReadTimeout extends ScriptEvidenceError {
  constructor() {
    super('script map-read budget exhausted');
  }
}

export async function beforeDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new MapReadTimeout()), Math.max(0, deadline - performance.now()));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function readResource(
  page: Page,
  client: CDPSession,
  url: string,
  scriptUrl: string,
  deadline: number,
): Promise<string> {
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',');
    if (comma < 0) throw new Error('invalid data URL');
    const payload = decodeURIComponent(url.slice(comma + 1));
    return checkedMapText(
      /;base64$/i.test(url.slice(0, comma)) ? Buffer.from(payload, 'base64').toString('utf8') : payload,
    );
  }
  if (url.startsWith('file:')) {
    // sourceURL can spoof a script's scheme; an HTTP document must never gain filesystem access.
    if (new URL(page.url()).protocol !== 'file:')
      throw new ScriptEvidenceError('file source map refused for non-file script');
    return readFileSourceMap(
      url,
      scriptUrl,
      AbortSignal.timeout(Math.max(1, Math.min(RESOURCE_TIMEOUT_MS, Math.floor(deadline - performance.now())))),
    );
  }
  // These requests use page credentials and Playwright/HAR routing; see the capture reference.
  try {
    return checkedMapText(
      await beforeDeadline(
        page.evaluate(
          async ({ address, timeout }) => {
            const response = await fetch(address, { credentials: 'include', signal: AbortSignal.timeout(timeout) });
            if (!response.ok) throw new Error('source map request failed');
            return response.text();
          },
          {
            address: url,
            timeout: Math.max(1, Math.min(RESOURCE_TIMEOUT_MS, Math.floor(deadline - performance.now()))),
          },
        ),
        deadline,
      ),
    );
  } catch (error) {
    if (error instanceof ScriptEvidenceError) throw error;
    if (performance.now() >= deadline) throw new MapReadTimeout();
    if (routingActive(page)) throw new ScriptEvidenceError('source map fallback refused during routing or HAR replay');
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
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await client.send('IO.read', { handle: resource.stream });
      const data = Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8');
      bytes += data.length;
      chunks.push(data);
      if (bytes > MAX_MAP_BYTES) throw new ScriptEvidenceError('source map input size limit exceeded');
      if (chunk.eof) return checkedMapText(Buffer.concat(chunks).toString('utf8'));
    }
  } finally {
    await client.send('IO.close', { handle: resource.stream }).catch(() => {});
  }
}
