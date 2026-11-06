/** Pure, self-contained functions; also installed in the browser from their source. */
export function canonicalEngineKeyframes(
  frames: readonly unknown[],
  order: typeof orderIndependentFrames = orderIndependentFrames,
): string | undefined {
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
  return JSON.stringify(order(result));
}

/** Lexicographically order commuting frames; shared properties retain their engine order. */
export function orderIndependentFrames(
  frames: Record<string, unknown>[],
  order: typeof orderFrameGroup = orderFrameGroup,
): Record<string, unknown>[] {
  const groups = new Map<unknown, Record<string, unknown>[]>();
  for (const frame of frames) {
    const group = groups.get(frame.offset) ?? [];
    group.push(frame);
    groups.set(frame.offset, group);
  }
  return [...groups.values()].flatMap((group) => order(group));
}

/** Canonical topological order within one offset, with an edge per shared property. */
export function orderFrameGroup(
  group: Record<string, unknown>[],
  dependencies: typeof frameDependencies = frameDependencies,
): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  const keys = group.map((frame) => JSON.stringify(frame));
  const { edges, indegree } = dependencies(group);
  const ready: number[] = [];
  const less = (a: number, b: number): boolean => keys[a] < keys[b] || (keys[a] === keys[b] && a < b);
  const push = (value: number): void => {
    let index = ready.length;
    ready.push(value);
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if (!less(value, ready[parent])) break;
      ready[index] = ready[parent];
      index = parent;
    }
    ready[index] = value;
  };
  const pop = (): number => {
    const first = ready[0];
    const last = ready.pop()!;
    if (!ready.length) return first;
    let index = 0;
    while (index * 2 + 1 < ready.length) {
      let child = index * 2 + 1;
      if (child + 1 < ready.length && less(ready[child + 1], ready[child])) child++;
      if (!less(ready[child], last)) break;
      ready[index] = ready[child];
      index = child;
    }
    ready[index] = last;
    return first;
  };
  for (const [index, count] of indegree.entries()) if (count === 0) push(index);
  while (ready.length) {
    const index = pop();
    result.push(group[index]);
    for (const next of edges[index]) if (--indegree[next] === 0) push(next);
  }
  return result;
}

/** Only adjacent occurrences per property need edges to preserve all dependent order. */
export function frameDependencies(group: Record<string, unknown>[]): { edges: Set<number>[]; indegree: number[] } {
  const edges = group.map(() => new Set<number>());
  const indegree = group.map(() => 0);
  const previous = new Map<string, number>();
  for (const [index, frame] of group.entries())
    for (const property of Object.keys(frame)) {
      if (['offset', 'easing', 'composite'].includes(property)) continue;
      const prior = previous.get(property);
      if (prior !== undefined && !edges[prior].has(index)) {
        edges[prior].add(index);
        indegree[index]++;
      }
      previous.set(property, index);
    }
  return { edges, indegree };
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
  const marker = names.some(
    (name) => /^(?:sig|signature|token|hdnts|__token__|oh|key-pair-id)$/.test(name) || /^x-.+-signature$/.test(name),
  );
  const retained = query.filter((_, index) => {
    const name = names[index];
    if (['token', 'access_token', 'awsaccesskeyid', 'hdnts', '__token__', 'x-amz-security-token'].includes(name))
      return false;
    if (marker && /^(?:exp|expires|expiry|se|st|oe|oh)$/.test(name)) return false;
    if (/^x-.+-signature$/.test(name)) return false;
    if (aws && name.startsWith('x-amz-')) return false;
    if (google && name.startsWith('x-goog-')) return false;
    if (signed && /^(?:signature|key-pair-id|expires|policy)$/.test(name)) return false;
    return !(sas && /^(?:sig|se|sp|sv|st|sr|ss|srt|si|skt|ske|skoid|sktid|sks|skv|sdd|spr)$/.test(name));
  });
  if (retained.length !== query.length) url.search = retained.join('&');
  return url.origin === origin ? `${url.pathname}${url.search}${url.hash}` : url.href;
}
