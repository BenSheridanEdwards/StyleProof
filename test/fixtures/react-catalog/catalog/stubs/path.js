// Browser-safe stub for node:path. Schema-only validation reads `sep` and
// `isAbsolute`; filesystem resolution remains unavailable because the fixture
// never passes `cwd`.
const unavailable = (name) => () => {
  throw new Error(`node:path.${name} is unavailable in the browser fixture`);
};

export default {
  sep: '/',
  resolve: unavailable('resolve'),
  relative: unavailable('relative'),
  isAbsolute: (value) => value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value),
  extname: unavailable('extname'),
  join: unavailable('join'),
};
