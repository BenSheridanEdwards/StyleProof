/** Pure, self-contained functions; also installed in the browser from their source. */
export function canonicalEngineKeyframes(frames: readonly unknown[]): string | undefined {
  const aliases: Record<string, string> = {
    ease: 'cubic-bezier(0.25,0.1,0.25,1)',
    'ease-in': 'cubic-bezier(0.42,0,1,1)',
    'ease-out': 'cubic-bezier(0,0,0.58,1)',
    'ease-in-out': 'cubic-bezier(0.42,0,0.58,1)',
    linear: 'cubic-bezier(0,0,1,1)',
  };
  if (!frames.length) return undefined;
  const result: Record<string, unknown>[] = [];
  for (const value of frames) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const frame = value as Record<string, unknown>;
    const offset = frame.computedOffset ?? frame.offset;
    if (typeof offset !== 'number' || !Number.isFinite(offset) || offset < 0 || offset > 1) return undefined;
    if (typeof frame.easing !== 'string' || typeof frame.composite !== 'string') return undefined;
    const properties = Object.entries(frame).filter(
      ([key]) => !['offset', 'computedOffset', 'easing', 'composite'].includes(key),
    );
    if (properties.some(([, property]) => typeof property !== 'string')) return undefined;
    result.push({
      offset,
      easing: aliases[frame.easing] ?? frame.easing.replace(/,\s*/g, ','),
      composite: frame.composite,
      ...Object.fromEntries(properties.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    });
  }
  return JSON.stringify(result);
}

/** Unknown is undefined; only a verified absence is null. */
export function resolveEngineBody(evidence: {
  body?: string;
  hasLive: boolean;
  expected?: string;
  matched?: string;
  ambiguous: boolean;
  verified: boolean;
  complete?: boolean;
}): string | null | undefined {
  if (!evidence.verified || evidence.ambiguous || evidence.complete === false) return undefined;
  if (!evidence.hasLive) return evidence.expected === undefined ? null : undefined;
  return evidence.body !== undefined && evidence.expected !== undefined && evidence.expected === evidence.matched
    ? evidence.body
    : undefined;
}

/** Keep unsigned query identity and raw spelling while removing known signing fields. */
export function normalizeImageSource(source: string, origin: string, base: string, complete: boolean): string {
  if (!source) return complete ? '(no source)' : '';
  const url = new URL(source, base);
  if (url.protocol === 'blob:') return '(blob URL; not compared)';
  if (!/^https?:$/.test(url.protocol)) return source;
  const query = url.search.slice(1).split('&');
  const names = query.map((part) => (new URLSearchParams('?' + part).keys().next().value ?? '').toLowerCase());
  const has = (name: string): boolean => names.includes(name);
  const aws = has('x-amz-signature') || has('x-amz-credential');
  const google = has('x-goog-signature') || has('x-goog-credential');
  const signed = has('signature') || has('key-pair-id');
  const sas = has('sig');
  const bunny = has('token');
  const retained = query.filter((_, index) => {
    const name = names[index];
    if (['token', 'access_token', 'awsaccesskeyid', 'hdnts', '__token__'].includes(name)) return false;
    if (bunny && (name === 'expires' || name === 'exp')) return false;
    if (aws && name.startsWith('x-amz-')) return false;
    if (google && name.startsWith('x-goog-')) return false;
    if (signed && /^(?:signature|key-pair-id|expires|policy)$/.test(name)) return false;
    return !(sas && /^(?:sig|se|sp|sv|st|sr|ss|srt|si|skt|ske|skoid|sktid|sks|skv|sdd|spr)$/.test(name));
  });
  if (retained.length !== query.length) url.search = retained.join('&');
  return url.origin === origin ? `${url.pathname}${url.search}${url.hash}` : url.href;
}
