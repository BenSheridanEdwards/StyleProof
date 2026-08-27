// Browser-safe stub for node:fs. The manifest validator imports node:fs so the
// same core module runs in a browser bundle; the fixture never passes `cwd`,
// so no function is ever called — every call fails loudly instead of lying.
const unavailable = (name) => () => {
  throw new Error(`node:fs.${name} is unavailable in the browser fixture`);
};

export default {
  realpathSync: unavailable('realpathSync'),
  statSync: unavailable('statSync'),
  readdirSync: unavailable('readdirSync'),
  existsSync: unavailable('existsSync'),
};
