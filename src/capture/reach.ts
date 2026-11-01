// Served-rule ledger for Change Reach (#991): every CSS leaf rule the page serves,
// and whether it matched a compared element while the map was read. Chromium's rule usage
// tracking reports the matched ranges, forced :hover/:focus/:active included; the
// stylesheet text names the rules. Stylesheets StyleProof injects never enter it.
import { createHash } from 'node:crypto';
import type { CDPSession, Page } from '@playwright/test';
import type { ServedRule, ServedRules } from './types.js';
import { GENERATED_PSEUDOS } from '../pseudo-references.js';

type UsedRange = { startOffset: number; endOffset: number };
type SheetHeader = {
  styleSheetId: string;
  sourceURL: string;
  origin: string;
  isInline: boolean;
  isConstructed?: boolean;
  frameId?: string;
  ownerNode?: number;
};

const digest = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);
// Grouping at-rules hold rules; every other block is a leaf (style rule, @keyframes, @font-face…).
const GROUPING = /^@(media|supports|layer|container|scope|document|starting-style)\b/i;
// Mirror PSEUDOS in capturePage (browser.ts), which is serialized and cannot be imported.
const CAPTURED_PSEUDO_ELEMENTS = new Set(['::before', '::after', '::marker', '::placeholder', ...GENERATED_PSEUDOS]);
// Mirrors the pseudo-elements browser.ts snapSubtree reads under a forced state (serialized, so not importable).
// ::marker is left out: forced reads skip it on fields.
const FORCED_PSEUDO_ELEMENTS = new Set(['::before', '::after', '::placeholder']);
// Pseudo-classes whose matching depends only on what comparedSnapshot fingerprints. Any other state
// (validity, open, defined, direction, design mode, visited, future pseudo-classes) is never attributed.
const FINGERPRINTED_PSEUDO_CLASSES = new Set([
  'is',
  'where',
  'not',
  'has',
  'root',
  'scope',
  'empty',
  'first-child',
  'last-child',
  'only-child',
  'first-of-type',
  'last-of-type',
  'only-of-type',
  'nth-child',
  'nth-last-child',
  'nth-of-type',
  'nth-last-of-type',
  'link',
  'any-link',
  'lang',
  'target',
  'checked',
  'disabled',
  'enabled',
  'required',
  'optional',
  'placeholder-shown',
]);
function unknown(detail: string): never {
  throw new Error(`styleproof: served CSS reach is unknown: ${detail}`);
}

/** A CSS escape includes up to six hex digits and their optional whitespace terminator. */
function escapeEnd(text: string, i: number): number {
  const escape = /^\\(?:[\da-f]{1,6}(?:\r\n|[ \t\r\n\f])?|\r\n|[^\r])/i.exec(text.slice(i));
  if (!escape) unknown('unterminated escape');
  return i + escape[0].length;
}

/** Strings, escapes and comments are opaque to delimiter and whitespace scans. */
function opaqueEnd(text: string, i: number): number {
  if (text.startsWith('/*', i)) {
    const end = text.indexOf('*/', i + 2);
    if (end === -1) unknown('unterminated comment');
    return end + 2;
  }
  if (text[i] === '\\') return escapeEnd(text, i);
  const quote = text[i];
  if (quote !== '"' && quote !== "'") return i;
  for (let end = i + 1; end < text.length;) {
    if (text[end] === quote) return end + 1;
    if (/[\r\n\f]/.test(text[end])) unknown('newline in string');
    end = text[end] === '\\' ? escapeEnd(text, end) : end + 1;
  }
  return unknown('unterminated string');
}

/** Next delimiter outside strings, comments, escapes and balanced component values. */
function delimiter(text: string, from: number, stops: string): number {
  const stack: string[] = [];
  const closes: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  for (let i = from; i < text.length; i++) {
    const end = opaqueEnd(text, i);
    if (end > i) {
      i = end - 1;
      continue;
    }
    const ch = text[i];
    if (!stack.length && stops.includes(ch)) return i;
    if (closes[ch]) stack.push(closes[ch]);
    else if (')]}'.includes(ch) && stack.pop() !== ch) unknown('unbalanced delimiter');
  }
  if (stack.length) unknown('unclosed block or component value');
  return text.length;
}

/** Collapse only CSS whitespace outside opaque tokens, preserving their significant contents. */
function collapse(text: string): string {
  let result = '';
  let space = '';
  for (let i = 0; i < text.length;) {
    const end = opaqueEnd(text, i);
    if (end === i && /[ \t\r\n\f]/.test(text[i])) {
      if (result) space = ' ';
      i++;
    } else {
      result += space + text.slice(i, end > i ? end : i + 1);
      space = '';
      i = end > i ? end : i + 1;
    }
  }
  return result;
}

function skipTrivia(text: string, from: number, to: number): number {
  let i = from;
  while (i < to) {
    if (text.startsWith('/*', i)) i = opaqueEnd(text, i);
    else if (/[ \t\r\n\f]/.test(text[i])) i++;
    else break;
  }
  return i;
}

type LeafRule = { chain: string[]; prelude: string; body: string; start: number; end: number };

/** Leaf rules with their offsets, keeping the at-rule chain separate from selector combinators. */
function leafRules(text: string): LeafRule[] {
  const rules: LeafRule[] = [];
  const walk = (from: number, to: number, chain: string[]): void => {
    for (let i = skipTrivia(text, from, to); i < to; i = skipTrivia(text, i, to)) {
      const brace = delimiter(text, i, '{;}');
      if (text[brace] === ';' && text[i] === '@') {
        i = brace + 1;
        continue;
      }
      if (brace >= to || text[brace] !== '{') unknown('unsupported rule prelude');
      const close = delimiter(text, brace + 1, '}');
      if (close >= to) unknown('unclosed rule block');
      const prelude = collapse(text.slice(i, brace));
      if (GROUPING.test(prelude)) walk(brace + 1, close, [...chain, prelude]);
      else
        rules.push({
          chain,
          prelude,
          body: collapse(text.slice(brace + 1, close)),
          start: i,
          end: close + 1,
        });
      i = close + 1;
    }
  };
  walk(0, text.length, []);
  return rules;
}

/** Complete declaration values, including semicolons in strings/functions/custom-property blocks. */
function declarations(body: string): [string, string][] {
  const result: [string, string][] = [];
  for (let i = skipTrivia(body, 0, body.length); i < body.length;) {
    const end = delimiter(body, i, ';');
    const colon = delimiter(body.slice(0, end), i, ':{');
    if (body[colon] !== ':') unknown('nested rule or unsupported declaration');
    const property = collapse(body.slice(i, colon));
    if (!/^(?:--)?[\w-]+$/.test(property)) unknown('unsupported declaration name');
    const value = body.slice(colon + 1, end);
    if (!property.startsWith('--') && delimiter(value, 0, '{') < value.length)
      unknown('nested rule or unsupported declaration value');
    result.push([property, collapse(value)]);
    i = skipTrivia(body, end + 1, body.length);
  }
  return result;
}

/** Skip opaque text, but reject escaped function names that could spell var(). */
function referenceEnd(text: string, i: number): number {
  let end = opaqueEnd(text, i);
  if (text[i] !== '\\') return end;
  while (/[\w\u0080-\uffff-]/.test(text[end] ?? '') || text[end] === '\\') {
    end = text[end] === '\\' ? escapeEnd(text, end) : end + 1;
  }
  if (text[end] === '(') unknown('unsupported var() reference');
  return end;
}

/** Custom properties `text` reads through `var()`, past comments and in any case; a name it cannot parse is unknown. */
function varReads(text: string): string[] {
  const names: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const end = referenceEnd(text, i);
    if (end > i) {
      i = end - 1;
      continue;
    }
    if (!/^var\(/i.test(text.slice(i, i + 4)) || /[\w-]/.test(text[i - 1] ?? '')) continue;
    const start = skipTrivia(text, i + 4, text.length);
    const name = /^--[\w-]+/.exec(text.slice(start))?.[0];
    const after = name ? skipTrivia(text, start + name.length, text.length) : start;
    if (!name || (text[after] !== ',' && text[after] !== ')')) unknown('unsupported var() reference');
    names.push(name);
    i = start + name.length - 1;
  }
  return names;
}

/** The custom properties a body declares (name → value digest) and the ones it reads through `var()`. */
function customProperties(body: string, values: [string, string][]): Pick<ServedRule, 'vars' | 'uses' | 'aliases'> {
  const declared = values.filter(([property]) => property.startsWith('--'));
  const read = [...new Set(varReads(body))];
  const aliases: Record<string, string[]> = {};
  for (const [name, value] of declared) {
    const reads = varReads(value);
    if (reads.length) aliases[name] = [...new Set([...(aliases[name] ?? []), ...reads])].sort();
  }
  return {
    ...(declared.length ? { vars: Object.fromEntries(declared.map(([name, value]) => [name, digest(value)])) } : {}),
    ...(read.length ? { uses: read } : {}),
    ...(Object.keys(aliases).length ? { aliases } : {}),
  };
}

function commaValues(value: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < value.length;) {
    const end = delimiter(value, i, ',');
    values.push(value.slice(i, end).trim());
    i = end + 1;
  }
  return values;
}

function fontFamily(family: string): string {
  if (family[0] === '"' || family[0] === "'") {
    if (opaqueEnd(family, 0) !== family.length) unknown('unsupported font family');
    return family.slice(1, -1);
  }
  if (!/^[-\w]+(?: [-\w]+)*$/.test(family)) unknown('unsupported font family');
  return family;
}

/** Literal names and every identifier sub-run, including inside function arguments. */
function candidateToken(value: string): { text: string; identifier: boolean } {
  const number = /^[+-]?(?:\d*\.\d+|\d+)(?:[eE][+-]?\d+)?(?:[\w-]+|%)?/.exec(value);
  const identifier = /^(?:--|-?[_a-zA-Z\u0080-\uffff])[\w\u0080-\uffff-]*/.exec(value);
  return { text: number?.[0] ?? identifier?.[0] ?? value[0], identifier: !number && !!identifier };
}

function identifierSuffixes(run: string[]): string[] {
  return run.map((_, start) => run.slice(start).join(' '));
}

function unsupportedFunction(name: string, call: boolean, allowVars: boolean): boolean {
  if (!call) return false;
  return /^(?:(?:env|attr|inherit|ident)$|--)/i.test(name) || (!allowVars && /^var$/i.test(name));
}

function candidateNames(value: string, allowVars = false): string[] {
  if (value.includes('\\')) unknown('unsupported font or animation dependency');
  const names: string[] = [];
  let run: string[] = [];
  for (let i = 0; i < value.length;) {
    const end = referenceEnd(value, i);
    if (/["']/.test(value[i])) {
      names.push(value.slice(i + 1, end - 1));
      run = [];
    }
    if (end > i) {
      i = end;
      continue;
    }
    if (/\s/.test(value[i])) {
      i++;
      continue;
    }
    const token = candidateToken(value.slice(i));
    const functionName = token.identifier && value[i + token.text.length] === '(';
    if (unsupportedFunction(token.text, functionName, allowVars)) unknown('unsupported font or animation dependency');
    if (token.identifier && !functionName) {
      run.push(token.text);
      names.push(...identifierSuffixes(run));
    } else {
      run = [];
    }
    i += token.text.length;
  }
  return names;
}

/** Reject substitutions that can assemble a family across token boundaries. */
function adjacencyLiteral(
  value: string,
  i: number,
  opaque: number,
  token: string,
): { text: string; variable: boolean; numeric: boolean } {
  return {
    text: value.slice(i, opaque > i ? opaque : i + token.length),
    variable: false,
    numeric: opaque === i && /^[+.-]?\d/.test(token),
  };
}

function adjacencyTokens(value: string): { text: string; variable: boolean; numeric: boolean }[] {
  const tokens: { text: string; variable: boolean; numeric: boolean }[] = [];
  for (let i = 0; i < value.length;) {
    const significant = skipTrivia(value, i, value.length);
    if (significant > i) {
      i = significant;
      continue;
    }
    const opaque = referenceEnd(value, i);
    const token = candidateToken(value.slice(i));
    const call = value[i + token.text.length] === '(';
    const variable = call && /^var$/i.test(token.text);
    const url = call && /^url$/i.test(token.text);
    if (variable || url) {
      const start = i + token.text.length + 1;
      const close = delimiter(value, start, ')');
      if (variable) guardVarAdjacency(value.slice(start, close));
      tokens.push({ text: value.slice(i, close + 1), variable, numeric: false });
      i = close + 1;
    } else {
      tokens.push(adjacencyLiteral(value, i, opaque, token.text));
      i = opaque > i ? opaque : i + token.text.length;
    }
  }
  return tokens;
}

function guardVarAdjacency(value: string): void {
  const tokens = adjacencyTokens(value);
  tokens.forEach((token, index) => {
    if (!token.variable) return;
    const left = tokens[index - 1];
    const right = tokens[index + 1];
    if (
      (left && !left.numeric && ![',', '/', '('].includes(left.text)) ||
      (right && !right.numeric && ![',', '/', ')'].includes(right.text))
    )
      unknown('font substitution can join a family name');
  });
}

/** Identifiers in `animation`/`font` declarations: candidate @keyframes and @font-face names. */
function referencedNames(values: [string, string][]): { names: string[]; vars: string[] } {
  const vars: string[] = [];
  const names = values.flatMap(([property, value]) => {
    if (!/^(animation(?:-name)?|font(?:-family)?)$/i.test(property)) return [];
    if (/\\/.test(value)) unknown('unsupported font or animation dependency');
    const font = /^font/i.test(property);
    if (font) {
      guardVarAdjacency(value);
      vars.push(...varReads(value));
    }
    const candidates = candidateNames(value, font);
    if (/^font-family$/i.test(property) && !/\/\*|\(/.test(value)) return commaValues(value).map(fontFamily);
    if (/^font/i.test(property)) return candidates;
    if (candidates.some((name) => !/^[-\w ]+$/.test(name)) || /["']/.test(value.replace(/\/\*[\s\S]*?\*\//g, '')))
      unknown('unsupported animation dependency');
    if (/\/\*|\(/.test(value)) return candidates;
    return value.split(/[\s,]+/).filter((t) => /^(?:--|-?[_a-zA-Z])[\w-]*$/.test(t));
  });
  return { names: [...new Set(names)], vars: [...new Set(vars)] };
}

/**
 * Ledger entries for one stylesheet's text, marking a rule used when a matched range
 * from rule usage overlaps it. @keyframes and @font-face are never reported used:
 * rule usage only covers style rules, so their reach resolves through `refs`.
 */
export function servedRulesOf(text: string, used: readonly UsedRange[]): Omit<ServedRule, 'sheet'>[] {
  const entries = servedEntries(text, used);
  fontVarRefs(entries);
  return entries.map((entry) => entry.rule);
}

type ServedEntry = {
  rule: Omit<ServedRule, 'sheet'>;
  chain: string[];
  prelude: string;
  fontVars: string[];
  customValues: [string, string][];
};

function servedEntries(text: string, used: readonly UsedRange[]): ServedEntry[] {
  return leafRules(text).map((rule) => {
    const keyframes = /^@(?:-\w+-)?keyframes\b/i.test(text.slice(rule.start));
    const values = keyframes
      ? leafRules(rule.body).flatMap((frame) => declarations(frame.body))
      : declarations(rule.body);
    const propertyName = /^@property\s+(--[\w-]+)$/i.exec(rule.prelude)?.[1];
    if (/^@property\b/i.test(rule.prelude) && !propertyName) unknown('unsupported property registration name');
    const { names: refs, vars: fontVars } = referencedNames(values);
    if (/^@font-face$/i.test(rule.prelude) && values.some(([property]) => /^font$/i.test(property)))
      unknown('unsupported font or animation dependency');
    return {
      chain: rule.chain,
      prelude: rule.prelude,
      fontVars,
      customValues: values.flatMap(([name, value]) =>
        name.startsWith('--')
          ? [[name, value] as [string, string]]
          : propertyName && name.toLowerCase() === 'initial-value'
            ? [[propertyName, value] as [string, string]]
            : [],
      ),
      rule: {
        key: [...rule.chain, rule.prelude].join(' > '),
        hash: digest(rule.body),
        ...(used.some((r) => r.startOffset < rule.end && r.endOffset > rule.start) ? { used: true as const } : {}),
        ...customProperties(rule.body, values),
        ...(refs.length ? { refs } : {}),
      },
    };
  });
}

/** Union every possible declaration and registration, never a cascade winner. */
function fontVarRefs(entries: ServedEntry[], registrations: [string, string][] = []): Set<string> {
  const values = [...entries.flatMap((entry) => entry.customValues), ...registrations];
  const closure = new Set<string>();
  for (const entry of entries) {
    const visited = new Set<string>();
    const pending = [...entry.fontVars];
    const names = new Set(entry.rule.refs ?? []);
    while (pending.length) {
      const name = pending.pop()!;
      if (visited.has(name)) continue;
      visited.add(name);
      closure.add(name);
      // Undeclared variables are guaranteed-invalid: inherited/initial families
      // are covered by the other rules' refs, so no invented family is needed.
      for (const [, value] of values.filter(([property]) => property === name)) {
        guardVarAdjacency(value);
        candidateNames(value, true).forEach((candidate) => names.add(candidate));
        pending.push(...varReads(value));
      }
    }
    if (names.size) entry.rule.refs = [...names].sort();
  }
  return closure;
}

function inlineDeclares(node: DocumentNode, names: ReadonlySet<string>): boolean {
  const attributes = node.attributes ?? [];
  for (let i = 0; i < attributes.length; i += 2) {
    if (attributes[i].toLowerCase() !== 'style') continue;
    if ([...names].some((name) => attributes[i + 1].includes(name))) return true;
    if (!/var\(|\\/i.test(attributes[i + 1])) continue;
    if (attributes[i + 1].includes('\\')) unknown('escaped inline style dependency');
    if (
      declarations(attributes[i + 1]).some(
        ([property, value]) => /^(font(?:-family)?|animation(?:-name)?)$/i.test(property) && varReads(value).length,
      )
    )
      return true;
  }
  return Boolean(
    node.children?.some((child) => inlineDeclares(child, names)) ||
    node.shadowRoots?.some((child) => inlineDeclares(child, names)) ||
    (node.contentDocument && inlineDeclares(node.contentDocument, names)),
  );
}

/** Selector for the originating elements, or undefined when their scope cannot be attributed. */
export function comparedProbe(prelude: string, chain: readonly string[]): string | undefined {
  return selectorProbe(prelude, chain)?.selector;
}

type SelectorProbe = { selector: string; relaxed: boolean; nested: boolean };

// Shadow-only semantics, uncaptured pseudo-elements and names the ASCII scanner cannot safely transform.
function unattributablePseudo(rest: string): boolean {
  return (
    /^::?[\w-]*(?:\\|\P{ASCII})/u.test(rest) ||
    /^(?::host(?:-context)?|::(?:slotted|part))(?![\w-])/i.test(rest) ||
    (rest.startsWith('::') && !CAPTURED_PSEUDO_ELEMENTS.has(/^::[\w-]+/.exec(rest)?.[0]?.toLowerCase() ?? ''))
  );
}

/** End and normalised `::name` of a captured pseudo-element, including the legacy single-colon forms. */
function pseudoElementEnd(prelude: string, start: number): { end: number; name: string } | undefined {
  const element = /^::?[\w-]+/.exec(prelude.slice(start))?.[0];
  if (!element) return undefined;
  const name = `::${element.replace(/^::?/, '').toLowerCase()}`;
  const legacy = /^:(?:before|after|first-line|first-letter)$/i.test(element);
  if (!element.startsWith('::') && !legacy) return undefined;
  return CAPTURED_PSEUDO_ELEMENTS.has(name) ? { end: start + element.length, name } : undefined;
}

/** End of a forced action state, including any balanced arguments. */
function forcedStateEnd(prelude: string, start: number): number {
  const removed = /^:(?:hover|focus-visible|focus-within|focus|active)(?![\w-])/i.exec(prelude.slice(start));
  if (!removed) return start;
  const end = start + removed[0].length;
  return prelude[end] === '(' ? delimiter(prelude, end + 1, ')') + 1 : end;
}

/** Classify a pseudo token, leaving ordinary characters in place and rejecting unattributable state. */
function selectorPseudo(
  prelude: string,
  start: number,
): { end: number; elements: string[]; forced: boolean } | undefined {
  const rest = prelude.slice(start);
  if (unattributablePseudo(rest)) return undefined;
  const element = pseudoElementEnd(prelude, start);
  if (element) {
    // A pseudo-element ends its selector; capture never reads what follows (`::before::marker`, `::before:hover`).
    const next = skipTrivia(prelude, element.end, prelude.length);
    if (next < prelude.length && prelude[next] !== ',') return undefined;
    return { end: element.end, elements: [element.name], forced: false };
  }
  const forcedEnd = forcedStateEnd(prelude, start);
  if (forcedEnd > start) return { end: forcedEnd, elements: [], forced: true };
  const pseudoClass = /^:([\w-]+)/.exec(rest);
  if (pseudoClass && !FINGERPRINTED_PSEUDO_CLASSES.has(pseudoClass[1].toLowerCase())) return undefined;
  return { end: start, elements: [], forced: false };
}

function selectorProbe(prelude: string, chain: readonly string[]): SelectorProbe | undefined {
  if (prelude.startsWith('@') || chain.some((part) => /^@(scope|container)\b/i.test(part))) return undefined;
  let probe = '';
  let standalone = true;
  let depth = 0;
  let relaxed = false;
  let nested = false;
  let forced = false;
  const elements: string[] = [];
  const remove = (end: number) => {
    relaxed = true;
    nested ||= depth > 0;
    if (standalone) probe += '*';
    standalone = false;
    return end;
  };
  for (let i = 0; i < prelude.length;) {
    const opaque = prelude[i] === '[' ? delimiter(prelude, i + 1, ']') + 1 : opaqueEnd(prelude, i);
    if (opaque > i) {
      standalone = standalone && prelude.startsWith('/*', i);
      probe += prelude.slice(i, opaque);
      i = opaque;
      continue;
    }
    const pseudo = selectorPseudo(prelude, i);
    if (!pseudo) return undefined;
    if (pseudo.end > i) {
      forced ||= pseudo.forced;
      elements.push(...pseudo.elements);
      i = remove(pseudo.end);
      continue;
    }
    depth += Number(prelude[i] === '(') - Number(prelude[i] === ')');
    standalone = /[\s>+~(,]/.test(prelude[i]);
    probe += prelude[i++];
  }
  // Rule usage is per rule, so one forced state on an unread pseudo-element makes the whole rule unattributable.
  if (forced && elements.some((name) => !FORCED_PSEUDO_ELEMENTS.has(name))) return undefined;
  return { selector: probe, relaxed, nested };
}

type ComparedProbes = { probes: (string | null)[]; exclusive: boolean[]; compared: string[] };

/** Serialized in-page: fingerprint and selector matches observe the same DOM without an intervening await. */
export function comparedSnapshot(input?: ComparedProbes): { fingerprint: string; matched: boolean[] } {
  const walk = (element: Element): unknown[] => [
    element.tagName,
    [...element.attributes].map(({ name, value }) => `${name}=${JSON.stringify(value)}`),
    Boolean((element as HTMLInputElement).checked || (element as HTMLOptionElement).selected),
    element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value === '' : null,
    [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && Boolean(node.nodeValue)),
    [...element.children].map(walk),
  ];
  const fingerprint = JSON.stringify([location.hash, walk(document.documentElement)]);
  if (!input) return { fingerprint, matched: [] };
  const { probes, exclusive, compared } = input;
  const pathOf = (window as unknown as { __spPathOf?: (el: Element) => string }).__spPathOf;
  if (!pathOf) throw new Error('styleproof: compared reach requires __spPathOf');
  const paths = new Set(compared);
  const elements = new Set(
    [document.documentElement, document.body, ...document.querySelectorAll('body *')].filter((el) =>
      paths.has(pathOf(el)),
    ),
  );
  const matched = probes.map((probe, index) => {
    if (probe === null) return false;
    try {
      // Mirror FRAMEWORK_IGNORE in capture.ts; this function is serialized into the page.
      const ignored =
        'head, meta, title, link, script, style, base, noscript, template, next-route-announcer, [id="__next-route-announcer__"], [data-styleproof-hover-sink]';
      const matches = [...document.querySelectorAll(probe)].filter((el) => !el.closest(ignored));
      // A relaxed selector cannot tell which candidate matched the original state.
      return matches.some((el) => elements.has(el)) && (!exclusive[index] || matches.every((el) => elements.has(el)));
    } catch {
      /* Invalid selectors cannot establish reach. */
    }
    return false;
  });
  return { fingerprint, matched };
}

/** A stable label for where a stylesheet came from: its URL path, `inline`, or `constructed`. */
function sheetLabel(header: SheetHeader): string {
  if (header.isConstructed) return 'constructed';
  if (header.isInline || !header.sourceURL) return 'inline';
  try {
    return new URL(header.sourceURL).pathname;
  } catch {
    return header.sourceURL.split(/[?#]/)[0];
  }
}

export type ServedRuleTracker = {
  /** Start recording rule usage and DOM state. Forces a style recalculation, so existing matches count. */
  start: () => Promise<void>;
  /**
   * Scope matches to `compared` paths, omitting `ownCss`. A DOM change makes all matches outside, and selectors
   * that depend on state outside the DOM fingerprint are never attributed. Can start again.
   */
  stop: (ownCss: readonly string[], compared: readonly string[]) => Promise<ServedRules>;
  /** Release the CDP session. Safe after a failed capture and safe to repeat. */
  dispose: () => Promise<void>;
};

type ReadSheet = { label: string; text: string; header: SheetHeader };

/** Each regular stylesheet's text in a stable order; linked sheets with no retained text are counted unreadable. */
async function readSheets(
  client: CDPSession,
  headers: Iterable<SheetHeader>,
  ownCss: readonly string[],
  browserOwned: ReadonlySet<number>,
): Promise<{ read: ReadSheet[]; unreadable: number }> {
  const read: ReadSheet[] = [];
  let unreadable = 0;
  for (const header of headers) {
    if (header.origin !== 'regular') continue;
    if (header.ownerNode !== undefined && browserOwned.has(header.ownerNode)) continue;
    const text = await client
      .send('CSS.getStyleSheetText', { styleSheetId: header.styleSheetId })
      .then((r) => r.text)
      .catch(() => undefined);
    const label = sheetLabel(header);
    // Chromium keeps a linked sheet's text only when the CSS domain was enabled before it loaded.
    if (text === undefined || (!text && label !== 'inline' && label !== 'constructed')) unreadable++;
    else if (!ownCss.includes(text.trim())) read.push({ label, text, header });
  }
  // Discovery order varies between runs; the ledger must not.
  const order = (s: ReadSheet): string => JSON.stringify([s.label, s.text]);
  read.sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
  if (read.some((sheet, i) => i > 0 && order(sheet) === order(read[i - 1]))) unknown('ambiguous identical stylesheets');
  return { read, unreadable };
}

type DocumentNode = {
  nodeId?: number;
  nodeName?: string;
  attributes?: string[];
  backendNodeId?: number;
  children?: DocumentNode[];
  shadowRoots?: DocumentNode[];
  shadowRootType?: string;
  contentDocument?: DocumentNode;
};

function userAgentOwned(root: DocumentNode): Set<number> {
  const owned = new Set<number>();
  const visit = (node: DocumentNode, inside: boolean): void => {
    const browser = inside || node.shadowRootType === 'user-agent';
    if (browser && node.backendNodeId !== undefined) owned.add(node.backendNodeId);
    node.children?.forEach((child) => visit(child, browser));
    node.shadowRoots?.forEach((child) => visit(child, browser));
    if (node.contentDocument) visit(node.contentDocument, browser);
  };
  visit(root, false);
  return owned;
}

function hasShadowRoot(node: DocumentNode): boolean {
  return Boolean(
    node.shadowRoots?.some((root) => root.shadowRootType !== 'user-agent' || hasShadowRoot(root)) ||
    node.children?.some(hasShadowRoot) ||
    (node.contentDocument && hasShadowRoot(node.contentDocument)),
  );
}

/** Missing ownership information is safe only on a document with no author shadow roots. */
async function documentSheet(
  client: CDPSession,
  header: SheetHeader,
  mainFrame: string,
  shadow: boolean,
): Promise<boolean> {
  if (!header.frameId || header.frameId !== mainFrame) return false;
  if (header.isConstructed && shadow) return false;
  if (!header.ownerNode) return !shadow;
  try {
    const { object } = await client.send('DOM.resolveNode', { backendNodeId: header.ownerNode });
    if (!object.objectId) return false;
    const { result } = await client.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: 'function () { return this.getRootNode() === document; }',
      returnByValue: true,
    });
    return result.value === true;
  } catch {
    return false;
  }
}

async function resolveFontVars(
  client: CDPSession,
  root: DocumentNode,
  read: ReadSheet[],
  entries: ServedEntry[][],
  mainFrame: string,
): Promise<void> {
  const allEntries = entries.flat();
  if (inlineDeclares(root, new Set())) unknown('inline font or animation variable reference');
  if (allEntries.some((entry) => entry.fontVars.length)) {
    if (
      read.some(
        (sheet, index) => sheet.header.frameId !== mainFrame && entries[index].some((entry) => entry.fontVars.length),
      )
    )
      unknown('font variable in another frame');
    const element = root.children?.find((node) => node.nodeName === 'HTML');
    const registrations = await client
      .send('CSS.getMatchedStylesForNode', { nodeId: element?.nodeId ?? root.nodeId ?? 0 })
      .catch(() => unknown('font property registrations unavailable'));
    const values: [string, string][] = [
      ...(registrations.cssPropertyRegistrations ?? []).flatMap((registration) =>
        registration.initialValue
          ? [[registration.propertyName, registration.initialValue.text] as [string, string]]
          : [],
      ),
      ...(registrations.cssPropertyRules ?? []).flatMap((registration) =>
        registration.style.cssProperties
          .filter((property) => property.name.toLowerCase() === 'initial-value')
          .map((property) => [registration.propertyName.text, property.value] as [string, string]),
      ),
    ];
    const closure = fontVarRefs(allEntries, values);
    if (inlineDeclares(root, closure)) unknown('font family set through an inline custom property');
  }
}

/**
 * Track the stylesheets a page serves. Arm it BEFORE navigating, like
 * `trackInflightRequests`: Chromium keeps a linked stylesheet's text, and reports its
 * rule usage, only when the CSS domain was enabled before the sheet loaded. A tracker
 * armed later still reads inline and constructed sheets and counts the rest unreadable.
 */
export async function trackServedRules(page: Page): Promise<ServedRuleTracker> {
  const client = await page.context().newCDPSession(page);
  const sheets = new Map<string, SheetHeader>();
  client.on('CSS.styleSheetAdded', ({ header }) => sheets.set(header.styleSheetId, header));
  client.on('CSS.styleSheetRemoved', ({ styleSheetId }) => sheets.delete(styleSheetId));
  const dispose = (): Promise<void> => client.detach().catch(() => undefined);
  try {
    await client.send('DOM.enable');
    await client.send('CSS.enable');
  } catch (error) {
    await dispose();
    throw error;
  }
  let started: string | undefined;
  const start = async (): Promise<void> => {
    await client.send('CSS.startRuleUsageTracking');
    started = digest((await page.evaluate(comparedSnapshot, undefined)).fingerprint);
  };
  const stop = async (ownCss: readonly string[], compared: readonly string[]): Promise<ServedRules> => {
    const { ruleUsage } = await client.send('CSS.stopRuleUsageTracking');
    const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
    const { read, unreadable } = await readSheets(client, [...sheets.values()], ownCss, userAgentOwned(root));
    const { frameTree } = await client.send('Page.getFrameTree');
    const shadow = hasShadowRoot(root);
    const rules: ServedRule[] = [];
    const probes: (string | null)[] = [];
    const exclusive: boolean[] = [];
    const entries = read.map((sheet) =>
      servedEntries(
        sheet.text,
        ruleUsage.filter((r) => r.used && r.styleSheetId === sheet.header.styleSheetId),
      ),
    );
    await resolveFontVars(client, root, read, entries, frameTree.frame.id);
    for (const [index, sheet] of read.entries()) {
      const inDocument = await documentSheet(client, sheet.header, frameTree.frame.id, shadow);
      for (const { rule, chain, prelude } of entries[index]) {
        const probe = rule.used && inDocument ? selectorProbe(prelude, chain) : undefined;
        // Removing a state inside :not(), for example, need not preserve the original candidates.
        probes.push(probe && !probe.nested ? probe.selector : null);
        exclusive.push(probe?.relaxed ?? false);
        rules.push({ ...rule, sheet: index });
      }
    }
    const { fingerprint, matched } = await page.evaluate(comparedSnapshot, {
      probes,
      exclusive,
      compared: [...compared],
    });
    const same = started !== undefined && digest(fingerprint) === started;
    started = undefined;
    const seen = new Map<string, number>();
    rules.forEach((rule, index) => {
      const n = (seen.get(rule.key) ?? 0) + 1;
      seen.set(rule.key, n);
      if (n > 1) rule.key += ` #${n}`;
      if (rule.used && (!same || !matched[index])) {
        delete rule.used;
        rule.outside = true;
      }
    });
    return {
      version: 2,
      sheets: read.map((s) => s.label),
      rules,
      scope: 'compared',
      ...(unreadable ? { unreadable } : {}),
    };
  };
  return { start, stop, dispose };
}
