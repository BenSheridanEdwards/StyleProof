import type { Finding, PropChange } from '../diff.js';
import { describeChange, toHex, type DescribeCtx, type ElementChange } from '../describe.js';
import { groupByPath, groupTitle, isNonValue, prettyLabel, summarizeProps } from '../change-groups.js';

type StyleFinding = Extract<Finding, { kind: 'style' }>;
type StateFinding = Extract<Finding, { kind: 'state' }>;
type DomFinding = Extract<Finding, { kind: 'dom' }>;

const ofKind = <K extends Finding['kind']>(findings: Finding[], kind: K) =>
  findings.filter((f): f is Extract<Finding, { kind: K }> => f.kind === kind);

/** Escape capture error text embedded in Markdown list prose (not inside code spans). */
export function escapeMarkdownFailureReason(reason: string): string {
  return reason
    .split('\n')[0]
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\\/g, '\\\\')
    .replace(/[*_[`#|]/g, '\\$&');
}

// C0/C1 controls plus the Unicode line/paragraph separators: any of them can end a
// Markdown line, so a map-supplied string carrying one could start a new block.
// eslint-disable-next-line no-control-regex -- intentional control-character class
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/**
 * Escape a map-supplied string for inline Markdown prose (outside code spans), so it
 * renders as literal text in the report and the PR comment: control characters and
 * newlines collapse to one space (no injected lines, checkboxes, or receipt markers),
 * HTML and Markdown metacharacters are escaped, and `@` mentions are neutralised.
 */
export function escapeInlineMarkdown(text: string): string {
  return text
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_[\]#!|~]/g, '\\$&')
    .replace(/@/g, '@\u200b');
}

// CSS values are author-influenced, so they get their own escaper at the render
// boundary: `|` is escaped (it would split the table row) and the code fence is
// widened past the value's longest backtick run (GitHub's code-span rule).
export function codeValue(v: string): string {
  const escaped = v.replace(CONTROL_CHARACTERS, ' ').replace(/\|/g, '\\|');
  const longestRun = Math.max(0, ...(escaped.match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(longestRun + 1);
  const pad = /^`|`$/.test(escaped) ? ' ' : '';
  return `${fence}${pad}${escaped}${pad}${fence}`;
}

// Non-values render as an em dash; colours as `#hex` so GitHub shows its swatch.
const cell = (v: string): string => (isNonValue(v) ? '—' : codeValue(toHex(v)));

const EXCERPT_AT = 64; // both sides at or under this → show whole values
const EXCERPT_CTX = 12; // chars of shared context kept around the diff
const EXCERPT_MAX = 96; // hard cap per excerpt

/** Long values are trimmed to their differing substring (plus context) on BOTH sides,
 *  so two long values can never render as identical cells for a real diff. */
function excerptPair(before: string, after: string): [string, string] {
  if (before.length <= EXCERPT_AT && after.length <= EXCERPT_AT) return [before, after];
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  let s = 0;
  const maxS = Math.min(before.length, after.length) - p;
  while (s < maxS && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  const cut = (v: string): string => {
    const start = Math.max(0, p - EXCERPT_CTX);
    let end = Math.min(v.length, v.length - s + EXCERPT_CTX);
    if (end - start > EXCERPT_MAX) end = start + EXCERPT_MAX;
    return (start > 0 ? '…' : '') + v.slice(start, end) + (end < v.length ? '…' : '');
  };
  return [cut(before), cut(after)];
}

function cellPair(before: string, after: string): [string, string] {
  if (isNonValue(before) || isNonValue(after)) return [cell(before), cell(after)];
  const [b, a] = excerptPair(before, after);
  return [codeValue(toHex(b)), codeValue(toHex(a))];
}

/** Value cells for one row: an added element shows only the value it takes. */
const valueCells = (c: PropChange, added: boolean): string[] => (added ? [cell(c.after)] : cellPair(c.before, c.after));

const table = (header: string[], rows: string[][]): string[] => [
  `| ${header.join(' | ')} |`,
  `| ${header.map(() => '---').join(' | ')} |`,
  ...rows.map((r) => `| ${r.join(' | ')} |`),
];

/** One-line, backtick-safe display text, clipped so the report stays scannable. */
export function clipText(s: string, max = 200): string {
  const t = s.replace(/\s+/g, ' ').replace(/`/g, "'").trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** One line per property change, stacked above the crop. `<br>` keeps GitHub from merging lines. */
export function propertyGlanceLine(findings: Finding[]): string {
  const parts: string[] = [];
  for (const group of groupByPath(findings)) {
    const added = ofKind(group, 'dom').some((f) => f.change === 'added');
    const styles = ofKind(group, 'style').map((s) => [s.pseudo ? `${codeValue(s.pseudo)} ` : '', s.props] as const);
    const states = ofKind(group, 'state').map((st) => [`${codeValue(`:${st.state}`)} `, st.props] as const);
    for (const [prefix, props] of [...styles, ...states]) {
      for (const c of summarizeProps(props)) {
        parts.push(`${prefix}${codeValue(c.prop)} ${valueCells(c, added).join(' → ')}`);
      }
    }
  }
  return parts.join('<br>\n');
}

function styleSection(styles: StyleFinding[], added: boolean): string[] {
  const out: string[] = [];
  for (const s of styles) {
    const rows = summarizeProps(s.props);
    if (!rows.length) continue;
    const heading = s.pseudo
      ? `On \`${s.pseudo}\`${added ? ' (head-side inventory — no baseline)' : ''}:`
      : added
        ? 'Style inventory (head-side — no baseline):'
        : 'Style:';
    const header = added ? ['Property', 'Value'] : ['Property', 'Before', 'After'];
    out.push(
      '',
      heading,
      '',
      ...table(
        header,
        rows.map((r) => [codeValue(r.prop), ...valueCells(r, added)]),
      ),
    );
  }
  return out;
}

function statesSection(states: StateFinding[], added: boolean): string[] {
  const rows = states.flatMap((st) =>
    summarizeProps(st.props).map((c) => [
      codeValue(`:${st.state}`),
      codeValue(c.prop),
      valueCells(c, added).join(' → '),
    ]),
  );
  if (!rows.length) return [];
  const header = ['State', 'Property', added ? 'Value' : 'Before → After'];
  return ['', added ? 'Interactive states:' : 'Interactive-state changes:', '', ...table(header, rows)];
}

const renderComponent = (c: NonNullable<DomFinding['component']>): string => {
  const entries = Object.entries(c.props ?? {});
  return `${codeValue(c.name)}${entries.length ? ` (${entries.map(([k, v]) => escapeInlineMarkdown(`${k}=${v}`)).join(', ')})` : ''}`;
};

const DOM_HEADING: Record<DomFinding['change'], (label: string, dom: DomFinding) => string> = {
  removed: (label) => `**Removed** \`${label}\``,
  added: (label) => `**Added** \`${label}\``,
  retagged: (label, dom) => `**Retagged** \`${label}\` ${escapeInlineMarkdown(dom.detail ?? '')}`,
};

/** One element's heading + body (no leading blank, no ×N suffix); null when nothing to show. */
function renderOneElement(group: Finding[]): { head: string; body: string[] } | null {
  const label = prettyLabel(group[0].path, group[0].cls);
  const dom = ofKind(group, 'dom')[0];
  if (dom?.change === 'removed') return { head: DOM_HEADING.removed(label, dom), body: [] };
  const added = dom?.change === 'added';
  const head = dom ? DOM_HEADING[dom.change](label, dom) : `**\`${label}\`**`;
  const body = [
    ...(dom?.component ? ['', `React component: ${renderComponent(dom.component)}`] : []),
    ...styleSection(ofKind(group, 'style'), added),
    ...statesSection(ofKind(group, 'state'), added),
  ];
  return !dom && !body.length ? null : { head, body };
}

/** Each changed element once, identical siblings collapsed into one `×N` block. */
function renderElements(findings: Finding[], maxElements = 40): string[] {
  const bySig = new Map<string, { head: string; body: string[]; count: number }>();
  for (const group of groupByPath(findings)) {
    const el = renderOneElement(group);
    if (!el) continue;
    const sig = `${el.head}\n${el.body.join('\n')}`;
    const seen = bySig.get(sig);
    if (seen) seen.count++;
    else bySig.set(sig, { ...el, count: 1 });
  }
  const blocks = [...bySig.values()];
  const out: string[] = [];
  for (const [i, b] of blocks.entries()) {
    if (i >= maxElements) {
      out.push('', `_…and ${blocks.length - i} more element(s) — see report.json._`);
      break;
    }
    out.push('', b.count > 1 ? `${b.head} ×${b.count}` : b.head, ...b.body);
  }
  return out;
}

/** Paths that are one-sided DOM adds/removes: their rows are inventories, not restyles. */
export function oneSidedDomPaths(findings: Finding[]): Set<string> {
  return new Set(
    ofKind(findings, 'dom')
      .filter((f) => f.change !== 'retagged')
      .map((f) => f.path),
  );
}

/** Plain-text `<summary>` (GitHub renders markdown inside it literally). */
function foldSummary(findings: Finding[]): string {
  const oneSided = oneSidedDomPaths(findings);
  const propFindings = findings.filter((f) => f.kind !== 'dom');
  const n = propFindings.flatMap((f) => summarizeProps(f.props)).length;
  if (!n) return 'Show details';
  if (propFindings.every((f) => oneSided.has(f.path))) {
    return n === 1 ? 'Show the head-side style inventory' : `Show all ${n} head-side inventory properties`;
  }
  return n === 1 ? 'Show the property change' : `Show all ${n} property changes`;
}

/** Per-element view for the plain-English summariser. */
function buildElementChanges(findings: Finding[]): ElementChange[] {
  return groupByPath(findings).map((group) => {
    const dom = ofKind(group, 'dom')[0];
    return {
      label: prettyLabel(group[0].path, group[0].cls),
      added: dom?.change === 'added',
      removed: dom?.change === 'removed',
      retagged: dom?.change === 'retagged',
      props: summarizeProps(ofKind(group, 'style').flatMap((f) => f.props)),
      states: [...new Set(ofKind(group, 'state').map((f) => f.state))],
    };
  });
}

/** A crop's changes: property tables, folded under plain-English bullets once they
 *  reach `foldAt` rows (≤ 0 folds always, Infinity never). */
export function renderCropChanges(findings: Finding[], foldAt: number, ctx: DescribeCtx): string[] {
  const tables = renderElements(findings);
  if (!tables.length) return [];
  const rows = findings.flatMap((f) => (f.kind === 'dom' ? [] : summarizeProps(f.props))).length;
  if (rows < foldAt) return tables;
  const bullets = describeChange(buildElementChanges(findings), ctx);
  const summary = bullets.length ? bullets.map((b) => `- ${b}`) : ['_see changes_'];
  return ['', ...summary, '', '<details>', `<summary>${foldSummary(findings)}</summary>`, ...tables, '', '</details>'];
}

/** A crop's heading: the anchor element, then what happened inside it. */
export function regionHeading(regionPaths: string[], findings: Finding[]): string {
  const anchors = [...regionPaths].sort((a, b) => a.split(' > ').length - b.split(' > ').length);
  const head = prettyLabel(anchors[0] ?? '', findings.find((f) => f.path === anchors[0])?.cls ?? '');
  const label = anchors.length > 1 ? `\`${head}\` + ${anchors.length - 1} more` : `\`${head}\``;
  return `${label} · ${groupTitle(findings)}`;
}
