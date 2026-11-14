import { humanLabel } from '../change-groups.js';
import { escapeInlineMarkdown } from '../code-span.js';

/** The elements a change section covers. */
export type SectionSubject = {
  tag: string;
  cls: string;
  /** A representative element path (the leaf tag is read from it when `tag` is empty). */
  path: string;
  /** Captured own text of each changed element ('' when none was captured). */
  texts: string[];
  /** Changed elements in the section. */
  count: number;
  /** Elements on the captured page with the same selector label. */
  sameSelectorCount: number;
};

const TAG_NOUNS: Record<string, string> = {
  a: 'link',
  article: 'article',
  aside: 'sidebar',
  button: 'button',
  dialog: 'dialog',
  footer: 'footer',
  form: 'form',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  header: 'header',
  img: 'image',
  input: 'field',
  label: 'label',
  li: 'list item',
  main: 'main area',
  nav: 'navigation',
  ol: 'list',
  p: 'paragraph',
  section: 'section',
  select: 'dropdown',
  svg: 'icon',
  table: 'table',
  td: 'cell',
  textarea: 'text box',
  th: 'cell',
  tr: 'row',
  ul: 'list',
};

/** Class words too terse to read as a name; the tag noun says it better. */
const TERSE_CLASSES = new Set(['btn', 'img', 'nav', 'el']);

const MAX_TEXT = 32;

const leafTag = (subject: Pick<SectionSubject, 'tag' | 'path'>): string =>
  (subject.tag || (subject.path.split('>').pop() ?? '').trim().replace(/[:.].*$/, '') || 'element').toLowerCase();

/** Short captured text, escaped: it is page content and reaches report.md and the PR comment. */
const shortText = (text: string): string | null => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t && t.length <= MAX_TEXT ? escapeInlineMarkdown(t) : null;
};

/** The text every element shares, when they all share one short text. */
function sharedText(texts: string[]): string | null {
  const cleaned = texts.map(shortText);
  return cleaned.length > 0 && cleaned.every((t) => t !== null && t === cleaned[0]) ? cleaned[0] : null;
}

/** Plural of the last word: "card title" → "card titles", "entry" → "entries". */
export function plural(noun: string): string {
  const words = noun.split(' ');
  const last = words.pop() ?? noun;
  const many = /(s|x|z|ch|sh)$/.test(last)
    ? `${last}es`
    : /[^aeiou]y$/.test(last)
      ? `${last.slice(0, -1)}ies`
      : `${last}s`;
  return [...words, many].join(' ');
}

/** The noun a section's elements go by: shared button/link text, the class, or the tag. */
export function sectionNoun(subject: Pick<SectionSubject, 'tag' | 'cls' | 'path' | 'texts'>): string {
  const tag = leafTag(subject);
  const tagNoun = TAG_NOUNS[tag] ?? 'element';
  const text = tag === 'button' || tag === 'a' ? sharedText(subject.texts) : null;
  if (text) return `${text} ${tagNoun}`;
  const first = (subject.cls.split(/\s+/)[0] ?? '').trim().toLowerCase();
  if (/^[a-z][a-z0-9-]*$/.test(first) && !TERSE_CLASSES.has(first)) {
    return humanLabel(subject.path, first).toLowerCase();
  }
  return tagNoun;
}

const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** The section's name: "Card titles", "Add to basket buttons", "Heading". */
export function sectionTitle(subject: SectionSubject): string {
  const noun = sectionNoun(subject);
  return capitalise(subject.count > 1 ? plural(noun) : noun);
}
