import { escapeInlineMarkdown } from '../code-span.js';
import { trackCount } from '../describe.js';
import type { Finding, PropChange } from '../diff.js';
import { groupByPath } from '../findings-clean.js';
import { humanLabel, prettyLabel, summarizeProps } from '../prop-summary.js';
import { CURRENTCOLOR_PROPERTIES } from '../pseudo-references.js';

const CURRENTCOLOR_FOLLOWERS = new Set([...CURRENTCOLOR_PROPERTIES, 'border-color']);

/** Border colours also follow currentColor; keep that echo out of the human summary. */
function primaryProperties(properties: PropChange[]): PropChange[] {
  const summarized = summarizeProps(properties);
  const colour = summarized.find(({ prop }) => prop === 'color');
  return summarized.filter(
    (property) =>
      !(
        colour &&
        CURRENTCOLOR_FOLLOWERS.has(property.prop) &&
        property.before === colour.before &&
        property.after === colour.after
      ),
  );
}

/** Value-free vocabulary for the comment. First matching family wins. */
const PROPERTY_FAMILIES: Array<[RegExp, string]> = [
  [/^background/, 'background'],
  [/radius/, 'corner radius'],
  [/^border/, 'border'],
  [/^outline/, 'outline'],
  [/^text-decoration-color$/, 'decoration colour'],
  [/^(fill|stroke)$/, 'icon colour'],
  [/color$/, 'colour'],
  [/^content$/, 'text content'],
  [/^padding/, 'padding'],
  [/^margin/, 'margin'],
  [/gap$/, 'gap'],
  [/^(font|text|line-height|letter-spacing|word-spacing)/, 'typography'],
  [/shadow$/, 'shadow'],
  [/^opacity$/, 'opacity'],
  [/^(visibility|content-visibility)$/, 'visibility'],
  [/^(min-|max-)?(width|height|block-size|inline-size)$/, 'size'],
  [
    /^(display|position|inset|top|right|bottom|left|transform|translate|rotate|scale|grid|flex|align|justify|order)/,
    'layout',
  ],
];

// Background/border/outline colours describe those families, rather than text colour.
function propertyFamily(property: string): string {
  return PROPERTY_FAMILIES.find(([pattern]) => pattern.test(property))?.[1] ?? '';
}

const TAG_NOUNS: Record<string, string> = {
  button: 'button',
  a: 'link',
  img: 'image',
  input: 'input',
  select: 'select',
  textarea: 'text area',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  p: 'paragraph',
  li: 'list item',
  ul: 'list',
  ol: 'list',
  nav: 'navigation',
};
// Class labels may already be plural; an ambiguous ending stays as written.
const pluralNoun = (noun: string): string =>
  /s$/i.test(noun)
    ? noun
    : /[^aeiou]y$/i.test(noun)
      ? noun.slice(0, -1) + 'ies'
      : /(x|ch|sh)$/i.test(noun)
        ? noun + 'es'
        : noun + 's';
const joinWords = (words: string[]): string =>
  words.length < 3 ? words.join(' and ') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
// GFM autolinks bare URLs/domains even after Markdown punctuation is escaped.
const plainText = (text: string): string =>
  escapeInlineMarkdown(text).replace(/:/g, ':\u200b').replace(/\./g, '\u200b.');

function elementNoun(finding: Finding): { noun: string; countNoun: string } {
  const selector = prettyLabel(finding.path, finding.cls);
  const tag = selector.split('.')[0];
  const human = humanLabel(finding.path, finding.cls);
  const plainTag = Object.hasOwn(TAG_NOUNS, tag) ? TAG_NOUNS[tag] : undefined;
  const useTag = plainTag && (human === tag || ['button', 'a', 'img', 'input', 'select', 'textarea'].includes(tag));
  const noun = useTag ? plainTag : human === tag && /^[a-z][a-z0-9]*$/i.test(tag) ? 'element' : human;
  return { noun: noun.charAt(0).toUpperCase() + noun.slice(1), countNoun: useTag ? plainTag : 'element' };
}

/** Compare like units only; mixed directions, keywords and different units are "changed". */
function spacingDirection(properties: PropChange[], family: string): string {
  const parts = (value: string) =>
    value
      .replace(/(\S+) ×([1-4])$/u, (_, repeated: string, count: string) =>
        Array(Number(count)).fill(repeated).join(' '),
      )
      .split(/\s+/);
  const directions = properties
    .flatMap(({ before, after }) => {
      const beforeParts = parts(before);
      const afterParts = parts(after);
      if (beforeParts.length !== afterParts.length) return [NaN];
      return beforeParts.map((value, index) => {
        const previous = value.match(/^(-?\d*\.?\d+)([a-z%]*)$/i);
        const next = afterParts[index].match(/^(-?\d*\.?\d+)([a-z%]*)$/i);
        const compatible =
          previous && next && (previous[2] === next[2] || Number(previous[1]) === 0 || Number(next[1]) === 0);
        if (!compatible) return NaN;
        const beforeNumber = Number(previous![1]);
        const afterNumber = Number(next![1]);
        if (family !== 'margin') return Math.sign(afterNumber - beforeNumber);
        if (beforeNumber * afterNumber < 0) return NaN;
        return Math.sign(Math.abs(afterNumber) - Math.abs(beforeNumber));
      });
    })
    .filter((direction) => direction !== 0);
  return directions.length && directions.every((direction) => direction === 1)
    ? 'more'
    : directions.length && directions.every((direction) => direction === -1)
      ? 'less'
      : '';
}

function propertyPhrases(properties: PropChange[]): string[] {
  const families = new Map<string, PropChange[]>();
  for (const property of primaryProperties(properties)) {
    const family = propertyFamily(property.prop);
    families.set(family, [...(families.get(family) ?? []), property]);
  }
  const knownFamilies = [...families].filter(([family]) => family);
  if (knownFamilies.length === 0) return families.size ? ['restyled'] : [];
  return knownFamilies.map(([family, members]) => {
    if (family === 'text content') return 'changed its text content';
    if (['padding', 'margin', 'gap'].includes(family)) {
      const direction = spacingDirection(members, family);
      return direction ? `got ${direction} ${family}` : `changed ${family}`;
    }
    const columns = members.find((property) => property.prop === 'grid-template-columns');
    // Only resolved computed tracks are countable; never guess about authored repeat()/subgrid.
    if (columns && !/repeat\(|subgrid|var\(/.test(columns.before + columns.after)) {
      const before = trackCount(columns.before);
      const after = trackCount(columns.after);
      if (before !== after && members.length === 1) return `went from ${before} columns to ${after}`;
    }
    return `changed ${family}`;
  });
}

const STATE_NAMES: Record<string, string> = {
  hover: 'hover',
  focus: 'focus',
  'focus-visible': 'focus',
  'focus-within': 'focus',
  active: 'active',
  disabled: 'disabled',
  checked: 'checked',
  visited: 'visited',
};

function changePhrase(findings: Finding[]): string {
  const dom = findings.find((finding) => finding.kind === 'dom');
  if (dom?.kind === 'dom') return `was ${dom.change}`;
  const phrases = propertyPhrases(findings.flatMap((finding) => (finding.kind === 'style' ? finding.props : [])));
  const interactions = new Set<string>();
  for (const finding of findings) {
    if (finding.kind !== 'state') continue;
    const families = new Set(primaryProperties(finding.props).map(({ prop }) => propertyFamily(prop) || 'styling'));
    const state = Object.hasOwn(STATE_NAMES, finding.state) ? STATE_NAMES[finding.state] : 'interaction';
    for (const family of families) interactions.add(`${state} ${family}`);
  }
  if (interactions.size) phrases.push(`got a new ${joinWords([...interactions])}`);
  return joinWords(phrases) || 'restyled';
}

export type SentenceChange = {
  noun: string;
  countNoun: string;
  phrase: string;
  elementKeys: Set<string>;
  where: string;
};

const sentenceLabel = (change: SentenceChange, plural: boolean): string =>
  plainText((plural ? pluralNoun(change.noun) : change.noun).slice(0, 80));

/**
 * Identify elements by path within a surface base, shared across widths and change groups.
 * Known tag nouns use that noun in the count; class-derived labels use "elements".
 * Surface names are supplied only when more than one changed product base is present.
 */
export function sentenceChanges(findings: Finding[], surfaces: string[] = [], nameSurfaces = true): SentenceChange[] {
  const where =
    nameSurfaces && surfaces.length
      ? ` on ${joinWords(surfaces.map((surface) => plainText(surface.replace(/[-_]+/g, ' '))))}`
      : '';
  return groupByPath(findings).map((element) => ({
    ...elementNoun(element[0]),
    phrase: changePhrase(element),
    elementKeys: new Set(
      (surfaces.length ? surfaces : ['']).map((surface) => JSON.stringify([surface, element[0].path])),
    ),
    where,
  }));
}

/** Merge the visible idea, including across change groups, while retaining its first position. */
export function mergeSentenceChanges(changes: SentenceChange[]): Array<{ change: SentenceChange; firstIndex: number }> {
  const groups = new Map<string, { change: SentenceChange; firstIndex: number }>();
  changes.forEach((change, firstIndex) => {
    const key = JSON.stringify([sentenceLabel(change, true), change.phrase, change.where]);
    const group = groups.get(key);
    if (group) {
      for (const elementKey of change.elementKeys) group.change.elementKeys.add(elementKey);
      if (group.change.countNoun !== change.countNoun) group.change.countNoun = 'element';
    } else groups.set(key, { change: { ...change, elementKeys: new Set(change.elementKeys) }, firstIndex });
  });
  return [...groups.values()];
}

export function formatChangeSentence(change: SentenceChange): string {
  const { elementKeys, countNoun, where } = change;
  const elementCount = elementKeys.size;
  const plural = elementCount > 1;
  const phrase = change.phrase
    .replace(/^was /, plural ? 'were ' : 'was ')
    .replace(/\bits\b/g, plural ? 'their' : 'its');
  const tally =
    elementCount === 1 && phrase.startsWith('went from')
      ? ''
      : ` (${elementCount} ${plural ? pluralNoun(countNoun) : countNoun})`;
  return `${sentenceLabel(change, plural)} ${phrase}${where}${tally}`;
}

/** One value-free line per visible idea, with all matching element counts combined. */
export function changeSentences(findings: Finding[], surfaces: string[] = []): string[] {
  return mergeSentenceChanges(sentenceChanges(findings, surfaces)).map(({ change }) => formatChangeSentence(change));
}
