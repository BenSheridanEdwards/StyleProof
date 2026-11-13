/** Read generated HTML without interpreting hidden markup as reader-visible text. */
export function visibleText(html, { reportStatements = false } = {}) {
  const lower = html.toLowerCase();
  let out = '';
  for (let i = 0; i < html.length;) {
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      i = end < 0 ? html.length : end + 3;
    } else if (html[i] === '<') {
      const end = html.indexOf('>', i + 1);
      if (end < 0) break;
      const closing = html[i + 1] === '/';
      const tag = lower
        .slice(i + (html[i + 1] === '/' ? 2 : 1), end)
        .trim()
        .split(/[\s/>]/, 1)[0];
      const skipped = reportStatements
        ? ['script', 'style', 'svg', 'table', 'summary', 'sub', 'figcaption']
        : ['script', 'style', 'svg'];
      const hidden =
        skipped.find((name) => tag.includes(name)) ??
        (reportStatements && tag === 'nav' && lower.slice(i, end).includes('toc') ? 'nav' : undefined);
      if (hidden && !closing) {
        const close = lower.indexOf(`</${hidden}`, end + 1);
        const closeEnd = close < 0 ? -1 : html.indexOf('>', close);
        i = closeEnd < 0 ? html.length : closeEnd + 1;
      } else {
        if (reportStatements) {
          const heading = /^h([1-6])$/.exec(tag);
          if (heading && !closing) out += `\n${'#'.repeat(Number(heading[1]))} `;
          else if (tag === 'li' && !closing) out += '\n- ';
          else if (
            !['strong', 'code', 'em', 'a', 'span', 'i', 'b', 'small'].includes(tag.startsWith('/') ? tag.slice(1) : tag)
          )
            out += '\n';
        }
        i = end + 1;
      }
    } else if (html[i] === '&') {
      const end = html.indexOf(';', i + 1);
      const entity = end < 0 ? '' : html.slice(i + (html[i + 1] === '/' ? 2 : 1), end);
      const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
      const number = entity.startsWith('#x')
        ? parseInt(entity.slice(2), 16)
        : /^#\d+$/.test(entity)
          ? Number(entity.slice(1))
          : NaN;
      const decoded =
        (Object.hasOwn(named, entity) ? named[entity] : undefined) ??
        (Number.isInteger(number) && number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : undefined);
      if (decoded !== undefined) {
        out += decoded;
        i = end + 1;
      } else out += html[i++];
    } else out += html[i++];
  }
  return out;
}
