/** CSS identifiers consume their escapes before any dot can become a class delimiter. */
const name = (char: string | undefined): boolean => !!char && /[\w\u0080-\uFFFF-]/.test(char);
function escaped(text: string, start: number): { end: number; value: string } {
  const hex = /^[\da-fA-F]{1,6}/.exec(text.slice(start + 1, start + 7))?.[0];
  if (!hex) return { end: Math.min(start + 2, text.length), value: text[start + 1] ?? '' };
  let end = start + 1 + hex.length;
  if (/[\t\n\f\r ]/.test(text[end] ?? '')) end += text.startsWith('\r\n', end) ? 2 : 1;
  const point = parseInt(hex, 16);
  return {
    end,
    value: String.fromCodePoint(!point || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff) ? 0xfffd : point),
  };
}
function identifier(text: string, start: number): { end: number; value: string } {
  let end = start,
    value = '';
  while (end < text.length) {
    if (text[end] === '\\') {
      const escape = escaped(text, end);
      value += escape.value;
      end = escape.end;
    } else if (name(text[end])) value += text[end++];
    else break;
  }
  return { end, value };
}
function opaqueEnd(text: string, start: number): number {
  const quote = text[start];
  const close = quote === '[' ? ']' : quote;
  for (let cursor = start + 1; cursor < text.length; cursor++) {
    if (text[cursor] === '\\') cursor = escaped(text, cursor).end - 1;
    else if (quote === '[' && /['"]/.test(text[cursor])) cursor = opaqueEnd(text, cursor) - 1;
    else if (text[cursor] === close) return cursor + 1;
  }
  return text.length;
}
function selectorPart(selector: string, cursor: number): { end: number; className?: string } {
  const char = selector[cursor];
  if ('[\'"'.includes(char)) return { end: opaqueEnd(selector, cursor) };
  if (selector.startsWith('/*', cursor)) {
    const end = selector.indexOf('*/', cursor + 2);
    return { end: end < 0 ? selector.length : end + 2 };
  }
  const start = char === '.' || char === '#' ? cursor + 1 : cursor;
  if (!name(selector[start]) && selector[start] !== '\\') return { end: cursor + 1 };
  const token = identifier(selector, start);
  return { end: token.end, ...(char === '.' && token.value ? { className: token.value } : {}) };
}
export function selectorClasses(selector: string): string[] {
  const classes: string[] = [];
  let cursor = 0;
  while (cursor < selector.length) {
    const part = selectorPart(selector, cursor);
    if (part.className) classes.push(part.className);
    cursor = part.end;
  }
  return classes;
}
