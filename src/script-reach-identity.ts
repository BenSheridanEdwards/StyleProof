import type { SourceMap } from './script-reach.js';

/** Only project-relative paths leave the reader; checkout roots and bundler namespaces are discarded. */
export function sourceIdentities(map: SourceMap, mapUrl: string): (string | undefined)[] {
  const paths = map.sources.map((source) => {
    if (source === null || /(^|[\\/])node_modules[\\/]/.test((map.sourceRoot ?? '') + '/' + source)) return undefined;
    const resolved = new URL(
      source.replaceAll('\\', '/'),
      new URL(map.sourceRoot ? map.sourceRoot.replace(/\/?$/, '/') : '.', mapUrl),
    );
    const pathname = decodeURIComponent(resolved.pathname).replaceAll('\\', '/');
    const src = pathname.lastIndexOf('/src/');
    return src >= 0 ? pathname.slice(src + 1) : pathname.replace(/^\/+/, '').replace(/^(?:\.\/)+/, '');
  });
  const absolute = paths.filter((value): value is string => value !== undefined && !value.startsWith('src/'));
  const prefix = absolute.length ? absolute[0].split('/').slice(0, -1) : [];
  for (const value of absolute) while (prefix.length && !value.startsWith(prefix.join('/') + '/')) prefix.pop();
  return paths.map((value) =>
    value === undefined || value.startsWith('src/')
      ? value
      : /^(?:Users|home)\//.test(value) && prefix.length < 2
        ? value.split('/').at(-1)
        : value.slice(prefix.length ? prefix.join('/').length + 1 : 0),
  );
}

/** Queries, fragments, credentials and ephemeral blob IDs are never stored. */
export function storedScriptUrl(address: string): string {
  if (address.startsWith('blob:')) return 'blob:';
  const url = new URL(address);
  url.search = '';
  url.hash = '';
  url.username = '';
  url.password = '';
  if (url.protocol === 'file:' || url.protocol === 'webpack:') {
    const path = decodeURIComponent(url.pathname);
    return `${url.protocol}/${path.includes('/src/') ? path.slice(path.lastIndexOf('/src/') + 1) : path.split('/').at(-1)}`;
  }
  const pathname = decodeURIComponent(url.pathname);
  if (/^\/(?:@fs\/)?(?:Users|home)\//.test(pathname))
    url.pathname =
      '/' +
      (pathname.includes('/src/') ? pathname.slice(pathname.lastIndexOf('/src/') + 1) : pathname.split('/').at(-1));
  return url.href;
}
