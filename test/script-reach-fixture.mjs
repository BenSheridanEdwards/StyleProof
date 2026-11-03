export function scriptReachFixture({
  entries,
  maps,
  source = 'x',
  mapUrl,
  blocked = false,
  routes = false,
  har = false,
} = {}) {
  const listeners = new Map(),
    calls = [];
  const coverage = entries ?? [
    {
      scriptId: '0',
      url: 'https://app.test/0.js',
      functions: [{ isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }] }],
    },
  ];
  const state = { _enabled: false, _eventListeners: [] };
  const context = {
    browser: () => ({ browserType: () => ({ name: () => 'chromium' }) }),
    newCDPSession: async () => client,
    _routes: har ? [{ matches: () => true }] : [],
    _harRouters: har ? [{}] : [],
  };
  const parsed = () =>
    coverage.forEach((e) =>
      listeners.get('Debugger.scriptParsed')?.({ ...e, sourceMapURL: mapUrl ?? `https://app.test/${e.scriptId}.map` }),
    );
  const client = {
    on(name, cb) {
      listeners.set(name, cb);
    },
    async detach() {
      calls.push(['detach']);
    },
    async send(method, params) {
      calls.push([method, params]);
      if (method === 'Debugger.enable' || method === 'Profiler.startPreciseCoverage') parsed();
      if (method === 'Profiler.takePreciseCoverage') return { result: coverage };
      if (method === 'Debugger.getScriptSource') return { scriptSource: source };
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
      if (method === 'Network.loadNetworkResource') return { resource: { success: true, stream: params.url } };
      if (method === 'IO.read')
        return {
          data: JSON.stringify(
            maps?.[Number(new URL(params.handle).pathname.match(/\d+/)?.[0] ?? 0)] ?? {
              version: 3,
              sources: ['src/a.js'],
              sourcesContent: [source],
              mappings: 'AAAA',
            },
          ),
          eof: true,
        };
      return {};
    },
  };
  const page = {
    _routes: routes ? [{ matches: () => true }] : [],
    _connection: { _objects: new Map(), toImpl: () => ({ coverage: { _jsCoverage: state } }) },
    coverage: {
      async startJSCoverage() {},
      async stopJSCoverage() {
        return [];
      },
    },
    context: () => context,
    url: () => coverage[0].url,
    on() {},
    off() {},
    once() {},
    async evaluate(_fn, arg) {
      if (blocked) throw new Error('fetch blocked');
      const id = Number(new URL(arg.address).pathname.match(/\d+/)?.[0] ?? 0);
      return JSON.stringify(
        maps?.[id] ?? { version: 3, sources: ['src/a.js'], sourcesContent: [source], mappings: 'AAAA' },
      );
    },
  };
  return {
    page,
    calls,
    client,
    state,
    context,
    emit: (name, value) => listeners.get(name)?.(value),
    navigate: () => listeners.get('Page.frameNavigated')?.({ frame: { id: 'main' } }),
  };
}
