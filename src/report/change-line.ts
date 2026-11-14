import type { PropChange, Finding } from '../diff.js';
import type { StyleMap } from '../capture.js';
import { summarizeProps, isGeometryOnlyGroup } from '../change-groups.js';
import { sectionNoun, plural, type SectionSubject } from './section-title.js';
import type { StateSource, ChangeSection } from './change-sections.js';
import { colorNameIfClose, toHex } from '../describe.js';
import { codeValue, escapeInlineMarkdown } from '../code-span.js';
import { isNonValue } from '../change-groups.js';

export type ChangeLineInput = {
  subject: SectionSubject;
  rest: Array<PropChange & { pseudo?: string }>;
  states?: Array<{ state: string; props: PropChange[]; driver?: SectionSubject }>;
  dom?: 'added' | 'removed' | 'retagged';
  geometryOnly?: boolean;
  size?: { dw: number; dh: number };
};

const MAX_TEXT = 32;

const shortText = (text: string): string | null => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t && t.length <= MAX_TEXT ? escapeInlineMarkdown(t) : null;
};

/** The text every element shares, when they all share one short text. */
function sharedText(texts: string[]): string | null {
  const cleaned = texts.map(shortText);
  return cleaned.length > 0 && cleaned.every((t) => t !== null && t === cleaned[0]) ? cleaned[0] : null;
}

const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

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
  return before && after ? `${label} from ${before} to ${after}` : label;
}

function fragmentList(fragments: string[]): string {
  if (fragments.length <= 2) return fragments.join(' and ');
  return `${fragments.slice(0, -1).join(', ')} and ${fragments[fragments.length - 1]}`;
}

export const STATE_WORDS: Record<string, string> = {
  hover: 'hovered',
  focus: 'focused',
  active: 'pressed',
  checked: 'checked',
  disabled: 'disabled',
  'placeholder-shown': 'showing its placeholder',
};

function stateClause(state: NonNullable<ChangeLineInput['states']>[number]): string {
  const fragments = state.props.map(propFragment);
  const words = fragmentList(fragments);
  const clause = words.includes(' from ') ? words.replace(' from ', ' changes from ') : `${words} changes`;
  const driver = state.driver ? `the ${sectionNoun(state.driver)} is ` : '';
  return `${clause} when ${driver}${STATE_WORDS[state.state] ?? `:${state.state}`}`;
}

function stateSentences(input: ChangeLineInput, who: string): string {
  return (input.states ?? [])
    .filter((s) => s.props.length)
    .map((s) => `${input.rest.length ? 'Its' : `On ${who}, the`} ${stateClause(s)}.`)
    .join(' ');
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

export function changeLine(input: ChangeLineInput): string {
  const who = subjectPhrase(input.subject, sectionNoun(input.subject));
  const many = input.subject.count > 1;
  const resting =
    structuralSentence(input, who, many) ??
    (input.rest.length
      ? `${capitalise(who)} ${many ? 'change' : 'changes'} ${fragmentList(input.rest.map(propFragment))}.${sizeSentence(input.size, many)}`
      : '');
  return [resting, stateSentences(input, who)].filter(Boolean).join(' ');
}
export function sectionLine(section: ChangeSection, maps: [StyleMap, StyleMap], states?: StateSource[]): string {
  const entry = (p: string) => maps[1].elements[p] ?? maps[0].elements[p];
  const first = section.findings.filter((f) => f.path === section.paths[0] && f.kind !== 'state');
  const rest = first.flatMap((f) =>
    f.kind === 'style' ? summarizeProps(f.props).map((p) => ({ ...p, ...(f.pseudo ? { pseudo: f.pseudo } : {}) })) : [],
  );
  const dom = first.find((f): f is Extract<Finding, { kind: 'dom' }> => f.kind === 'dom');
  const sizes = section.paths.map((p) => {
    const a = maps[0].elements[p]?.rect,
      b = maps[1].elements[p]?.rect;
    return a && b ? { dw: b[2] - a[2], dh: b[3] - a[3] } : undefined;
  });
  const size = sizes[0] && sizes.every((s) => s?.dw === sizes[0]?.dw && s?.dh === sizes[0]?.dh) ? sizes[0] : undefined;
  const e = entry(section.paths[0]);
  return changeLine({
    subject: {
      tag: e?.tag ?? '',
      cls: e?.cls ?? '',
      path: section.paths[0],
      texts: section.paths.map((p) => entry(p)?.text ?? ''),
      count: section.paths.length,
      sameSelectorCount: section.sameSelectorCount,
    },
    rest,
    ...(states
      ? {
          states: states.map((source: StateSource) => {
            const path = source.owners[0];
            const owner = entry(path);
            return {
              state: source.state,
              props: source.changes.flatMap((f) => summarizeProps(f.props)),
              ...(!source.own
                ? {
                    driver: {
                      tag: owner?.tag ?? '',
                      cls: owner?.cls ?? '',
                      path,
                      texts: [owner?.text ?? ''],
                      count: 1,
                      sameSelectorCount: 1,
                    },
                  }
                : {}),
            };
          }),
        }
      : {}),
    ...(dom ? { dom: dom.change } : {}),
    geometryOnly: isGeometryOnlyGroup(first),
    ...(size ? { size } : {}),
  });
}
