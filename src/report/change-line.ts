import type { PropChange } from '../diff.js';
import { colorNameIfClose, toHex } from '../describe.js';
import { codeValue, escapeInlineMarkdown } from '../code-span.js';
import { humanLabel, isNonValue, prettyLabel } from '../change-groups.js';

/**
 * A change section's name and its one plain-English line, built only from captured
 * data: element counts and text, colour names, values and box sizes. Deterministic,
 * and never a claim about why something changed.
 */

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

/** A change as a line says it; `painted`: a colour the element draws (a visible border), never an echo. */
export type StateProp = PropChange & { pseudo?: string; painted?: true };

/**
 * One owner group of a counted clause: the distinct changes these `count` owners all made (and no
 * other owner group says), `also` when they are some of an earlier group's owners.
 */
export type OwnerGroup = { count: number; props: StateProp[]; also?: true };

/**
 * One clause: a forced state's change(s); `driver` is the control that produced them, absent for the
 * element's own state. `ownToo`: the element's own state made the same change as the driver ("when
 * hovered or when the opt is hovered"). `groups`: a counted clause whose owners made different
 * changes, one group per owner (owners with the same change share one, with their `count`).
 */
export type StateChange = {
  state: string;
  props: StateProp[];
  /** A counted clause's owner count, for its groups' words ("each", "the other"). */
  owners?: number;
  driver?: StateDriver;
  ownToo?: true;
  groups?: OwnerGroup[];
};
/**
 * The owner(s) of one clause, as the capture records them (by owner path, never inferred):
 * - `owners`: how many owner paths made it (several only for one identical change: "either of the 2 opts");
 * - `counted`: owners of one selector the report cannot tell apart ("one of the 3 `input.chip` controls");
 * - `labels`: several selectors that made one identical change ("`input.pickr` or `select.pickr`");
 * - `matching`: each grouped element has its own owner; `name: 'label'`: named by selector, because
 *   another single owner's noun reads the same.
 */
export type StateDriver = {
  subject: Pick<SectionSubject, 'tag' | 'cls' | 'path' | 'texts'>;
  owners: number;
  counted?: { label: string; total: number };
  labels?: string[];
  matching?: true;
  name?: 'label';
};

export type ChangeLineInput = {
  subject: SectionSubject;
  /** Summarized resting prop changes, `pseudo` set for `::before` / `::after` rows. */
  rest: StateProp[];
  states: StateChange[];
  dom?: 'added' | 'removed' | 'retagged';
  /** Only size/position values moved: no styling property changed. */
  geometryOnly?: boolean;
  /** Size/position rows also moved at rest (folded from the view), so rest did not stay the same. */
  restFolded?: boolean;
  /** Box size change shared by every element, in px (head minus base). */
  size?: { dw: number; dh: number };
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

/** "1 element", "3 elements" (regular plurals only). */
export const counted = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "a", "a and b", "a, b and c". */
export const andList = (items: string[]): string =>
  items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : (items[0] ?? '');

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

/** "All 3 card titles (Lamp, Chair, Rug)", "2 of 5 cards", "The save button". */
function subjectPhrase(subject: SectionSubject, noun: string): string {
  const names = noun.startsWith(sharedText(subject.texts) ?? '\u0000') ? [] : subject.texts.map(shortText);
  const named =
    names.length > 0 && names.every((n): n is string => n !== null) && new Set(names).size === names.length
      ? ` (${names.slice(0, 3).join(', ')}${names.length > 3 ? ', …' : ''})`
      : '';
  if (subject.count === 1) {
    const one = subject.sameSelectorCount > 1 ? `1 of ${subject.sameSelectorCount} ${plural(noun)}` : `the ${noun}`;
    return `${one}${named}`;
  }
  const many = plural(noun);
  if (subject.sameSelectorCount > subject.count)
    return `${subject.count} of ${subject.sameSelectorCount} ${many}${named}`;
  return `${subject.count === 2 ? 'both' : `all ${subject.count}`} ${many}${named}`;
}

const PROP_WORDS: Record<string, string> = {
  'background-color': 'background',
  'border-color': 'border colour',
  'border-radius': 'corner radius',
  'border-width': 'border width',
  color: 'text colour',
  'column-gap': 'column gap',
  'font-size': 'text size',
  'font-weight': 'text weight',
  'letter-spacing': 'letter spacing',
  'line-height': 'line height',
  gap: 'gap',
  margin: 'margin',
  opacity: 'opacity',
  'outline-color': 'outline colour',
  padding: 'padding',
  'row-gap': 'row gap',
  'text-decoration-color': 'underline colour',
};

const MAX_VALUE = 24;

/** A value as a reviewer reads it: the value itself (a colour word is decided per pair). */
function valueWords(value: string): string | null {
  if (isNonValue(value)) return 'none';
  const v = toHex(value);
  return v.length <= MAX_VALUE ? codeValue(v) : null;
}

/** Colour words only when both sides have a genuinely close name; otherwise both values. */
function colorWords(prop: string, before: string, after: string): [string, string] | null {
  if (!/color$/.test(prop)) return null;
  const [b, a] = [colorNameIfClose(before), colorNameIfClose(after)];
  return b && a && b !== a ? [b, a] : null;
}

/** "text colour from dark indigo to dark red", "`box-shadow`" (long values left to the CSS table). */
function propFragment(change: PropChange & { pseudo?: string }): string {
  const name = PROP_WORDS[change.prop] ?? codeValue(change.prop);
  const label = change.pseudo ? `${codeValue(change.pseudo)} ${name}` : name;
  const words = colorWords(change.prop, change.before, change.after);
  if (words) return `${label} from ${words[0]} to ${words[1]}`;
  const before = valueWords(change.before);
  const after = valueWords(change.after);
  // A state side with no single resting value to name (a shorthand): say what the state does.
  if (change.before === '(state does not change it)' && after) return `${label} now changes to ${after}`;
  if (change.after === '(state no longer changes it)') return `${label} no longer changes`;
  return before && after ? `${label} from ${before} to ${after}` : label;
}

/**
 * Props that moved exactly like `color` read as one colour change in the sentence (the table lists
 * them all), unless the element draws them: a visible border turning red with the text is said
 * (QA16-01). These are the changes a line states.
 */
export function withoutColorEchoes<T extends StateProp>(props: T[]): T[] {
  const color = props.find((p) => p.prop === 'color' && !p.pseudo);
  if (!color) return props;
  return props.filter(
    (p) => p === color || p.painted || !/color$/.test(p.prop) || p.before !== color.before || p.after !== color.after,
  );
}

/** Up to two fragments, then "and N more properties". */
function fragmentList(fragments: string[]): string {
  if (fragments.length <= 2) return fragments.join(' and ');
  const rest = fragments.length - 2;
  return `${fragments.slice(0, 2).join(', ')} and ${rest} more ${rest === 1 ? 'property' : 'properties'}`;
}

/** The one table of forced-state words: change lines, pair labels and report.html read it. */
export const STATE_WORDS: Record<string, string> = {
  hover: 'hovered',
  focus: 'focused',
  active: 'pressed',
  checked: 'checked',
  disabled: 'disabled',
  'placeholder-shown': 'showing its placeholder',
};

const stateWord = (state: string): string => STATE_WORDS[state] ?? `:${state}`;

/** "background from blue to red" → "background changes from blue to red". */
const withVerb = (fragment: string): string =>
  / (?:now|no longer) changes/.test(fragment)
    ? fragment
    : fragment.includes(' from ')
      ? fragment.replace(' from ', ' changes from ')
      : `${fragment} changes`;

/** One clause; `grouped` clauses lead with their trigger and take no article. */
type Clause = { text: string; grouped?: true };

/** "background changes from blue to red when hovered" */
function stateClause(change: StateChange, driver: string | null): Clause {
  const word = stateWord(change.state);
  const when = !driver
    ? `when ${word}`
    : change.ownToo
      ? `when ${word} or when ${driver} ${word}`
      : `when ${driver} ${word}`;
  if (change.groups) return { text: `${when}, ${ownerGroups(change.groups, change.owners ?? 0)}`, grouped: true };
  const [first, ...more] = withoutColorEchoes(change.props).map(propFragment);
  return { text: `${fragmentList([withVerb(first), ...more])} ${when}` };
}

const MAX_GROUPS = 2;

/**
 * A counted clause's owner groups (QA15-01, QA16-01): each distinct change is said once, under the
 * owners that made it, with their count: "each changes the text colour …, and one also changes
 * the border colour …", "one changes the text colour …, while the other changes the background …".
 * Each group is capped like any change line; past two groups, "and N more changes".
 */
function ownerGroups(groups: OwnerGroup[], total: number): string {
  const said = (g: OwnerGroup, who: string) =>
    `${who} ${g.also ? 'also ' : ''}${g.count === 1 || g.count === total ? 'changes' : 'change'} ${fragmentList(g.props.map((p) => `the ${propFragment(p)}`))}`;
  const who = (g: OwnerGroup) => (g.count === total ? 'each' : g.count === 1 ? 'one' : `${g.count} of them`);
  const [first, second] = groups;
  if (groups.length === 2 && !second.also && first.count + second.count === total) {
    const other = second.count === 1 ? 'the other' : `the other ${second.count}`;
    return `${said(first, who(first))}, while ${said(second, other)}`;
  }
  if (groups.length === 2) return `${said(first, who(first))}, and ${said(second, who(second))}`;
  const shown = groups.slice(0, MAX_GROUPS).map((g) => said(g, who(g)));
  const rest = groups.slice(MAX_GROUPS).reduce((sum, g) => sum + g.props.length, 0);
  const tail = rest ? [`and ${rest} more ${rest === 1 ? 'change' : 'changes'}`] : [];
  return [...shown, ...tail].join('; ');
}

function sizeSentence(size: ChangeLineInput['size'], many: boolean): string {
  if (!size) return '';
  const parts = [
    size.dh ? `${Math.abs(size.dh)}px ${size.dh > 0 ? 'taller' : 'shorter'}` : '',
    size.dw ? `${Math.abs(size.dw)}px ${size.dw > 0 ? 'wider' : 'narrower'}` : '',
  ].filter(Boolean);
  if (!parts.length) return '';
  return ` ${many ? 'Each is' : 'It is'} now ${parts.join(' and ')}.`;
}

/** Added, removed, retagged or size-only elements: one fixed sentence each. */
function structuralSentence(input: ChangeLineInput, who: string, many: boolean): string | null {
  const Who = capitalise(who);
  if (input.dom === 'added' || input.dom === 'removed') {
    return `${Who} ${many ? 'are' : 'is'} ${input.dom === 'added' ? 'new on the page' : 'gone from the page'}.`;
  }
  if (input.dom === 'retagged') return `${Who} ${many ? 'change' : 'changes'} element type.`;
  if (!input.geometryOnly) return null;
  return `${Who} ${many ? 'change' : 'changes'} size/position only, no styling property changed.`;
}

/** "a and the b", "a, the b, and the c" */
function listClauses(clauses: string[], article: string): string {
  const [first, ...rest] = clauses;
  if (!rest.length) return first;
  const tail = rest.map((c) => `${article}${c}`);
  return rest.length === 1
    ? `${first}, and ${tail[0]}`
    : `${[first, ...tail.slice(0, -1)].join(', ')}, and ${tail[tail.length - 1]}`;
}

/** The forced-state sentences: after a resting change, "Their …"; alone, "On …, the …" plus the resting claim. */
function stateSentences(input: ChangeLineInput, who: string, many: boolean): string[] {
  // Each clause names its own source: the element's own state, or the control that produced it.
  const driverPhrase = (driver?: StateDriver): string | null => {
    if (!driver) return null;
    const label = codeValue(prettyLabel(driver.subject.path, driver.subject.cls));
    const noun = sectionNoun(driver.subject);
    const matching = driver.matching ? 'matching ' : '';
    if (driver.counted) return `one of the ${driver.counted.total} ${codeValue(driver.counted.label)} controls is`;
    if (driver.labels) return `${driver.labels.map(codeValue).join(' or ')} is`;
    if (driver.owners > 1)
      return `${driver.owners === 2 ? 'either' : 'any'} of the ${driver.owners} ${matching}${plural(noun)} is`;
    if (driver.name === 'label') return `${label} is`;
    return `the ${matching}${noun} is`;
  };

  // A grouped (counted) clause says its owners after its trigger, so it comes last.
  const all = input.states.filter((st) => st.props.length).map((st) => stateClause(st, driverPhrase(st.driver)));
  const clauses = [...all.filter((c) => !c.grouped), ...all.filter((c) => c.grouped)];
  if (!clauses.length) return [];
  const rest = input.restFolded ? [] : [many ? 'At rest they look the same.' : 'At rest it looks the same.'];
  if (input.rest.length) {
    const [first, ...more] = clauses;
    const lead = first.grouped ? capitalise(first.text) : `${many ? 'Their' : 'Its'} ${first.text}`;
    return [`${listClauses([lead, ...more.map((c) => c.text)], '')}.`];
  }
  const texts = clauses.map((c) => (c.grouped ? c.text : `the ${c.text}`));
  return [`On ${who}, ${listClauses(texts, '')}.`, ...rest];
}

/** The section's one plain-English line. */
export function changeLine(input: ChangeLineInput): string {
  const who = subjectPhrase(input.subject, sectionNoun(input.subject));
  const many = input.subject.count > 1;
  const structural = structuralSentence(input, who, many);
  if (structural) return structural;
  const fragments = withoutColorEchoes(input.rest).map(propFragment);
  const restSentence = input.rest.length
    ? [`${capitalise(who)} ${many ? 'change' : 'changes'} ${fragmentList(fragments)}.${sizeSentence(input.size, many)}`]
    : [];
  return [...restSentence, ...stateSentences(input, who, many)].join(' ').replace(/ {2,}/g, ' ');
}
