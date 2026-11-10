// #1299 oracle: every forced-state finding is attributed to the owner path the capture recorded.
//
// Truth is the capture's own record, keyed by OWNER PATH, never by selector label or class word:
// each state finding in report.json is (owner = `path`, state, target = `sub`, props). The clauses
// the capture supports for one element follow the CPO's round-18 fallback, main's own per-owner
// wording:
//   - one source per owner path in each state, with that owner's several changes in it;
//   - owners of one selector that stated the same changes are one source, as main collapses
//     identical blocks to ×N ("when `input.opt` ×3 is checked");
//   - the element's own state is always its own source;
//   - a change the element draws (border, outline, column rule, text stroke) is stated; a colour
//     that only follows the text colour is an echo and is not.
// For each change section, the rendered text (report.md or a PR comment) must hold, for its first
// element:
//   1. one sentence clause per source, named as main names it (noun, selector label, or label ×N),
//      naming every change its source made and nothing else; no counted wording and no "and N more"
//      tail; the element's own state said as its own ("when hovered");
//   3. in "Show the CSS", one block per owner path (×N only when N owners changed exactly that), its
//      `:state[ ::pseudo] prop` rows exactly what that owner changed, no row repeated, and identical
//      blocks one ×N block;
//   4. grouping: every element in the section has sources of the same shape.
// Test-only.
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { prettyLabel } from '../dist/change-groups.js';
import { STATE_WORDS } from '../dist/report/change-line.js';
import { repeatedChanges } from './rule5-detector.mjs';

const STATE_BY_WORD = Object.fromEntries(Object.entries(STATE_WORDS).map(([state, word]) => [word, state]));
const stripPseudo = (sub) => sub.replace(/::[\w-]+$/, '');
const pseudoOf = (sub) => (/::[\w-]+$/.exec(sub) ?? [''])[0];
/** Test vocabulary: a property as a change line names it, to read which properties a clause carries. */
const PROPERTY_WORDS = {
  'background-color': 'background',
  'border-color': 'border colour',
  color: 'text colour',
  'font-weight': 'text weight',
  'outline-color': 'outline colour',
};
/** Four border sides moving alike are said as one border colour. */
const propWord = (prop) => prop.replace(/^border-(?:top|right|bottom|left)-color$/, 'border-color');
const changeKey = (f) =>
  JSON.stringify([f.state, pseudoOf(f.sub), f.props.map((p) => [p.prop, p.before, p.after]).sort()]);
const labelOf = (f) => prettyLabel(f.path, f.cls ?? '');
const tagOf = (p) => (p.split('>').pop() ?? '').trim().replace(/[:.[].*$/, '');
const classWord = (f) => (f.cls ?? '').split(/[\s_-]/)[0].toLowerCase() || tagOf(f.path);

/** Every element entry in the captures under these directories (base and head), by path. */
export function elementsIn(...dirs) {
  const elements = {};
  for (const dir of dirs)
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json.gz')))
      Object.assign(elements, JSON.parse(gunzipSync(fs.readFileSync(path.join(dir, file)))).elements ?? {});
  return elements;
}

/** The name a reader tells an owner by: a button's or link's own text, else its class word or tag. */
const nameIn = (elements) => (f) => {
  const entry = elements[f.path];
  return (entry?.text && /^(?:button|a)$/.test(entry.tag) ? entry.text.trim() : classWord(f)).toLowerCase();
};

/** The colours an element draws (a border, outline, column rule or text stroke with a style and width). */
function drawnColors(entry) {
  const style = entry?.style ?? {};
  const drawn = (part) =>
    !['none', 'hidden', undefined].includes(style[`${part}-style`]) && style[`${part}-width`] !== '0px';
  return (prop) =>
    (/^border-(?:top|right|bottom|left)-color$/.test(prop) &&
      ['top', 'right', 'bottom', 'left'].some((side) => drawn(`border-${side}`))) ||
    (prop === 'outline-color' && drawn('outline')) ||
    (prop === 'column-rule-color' && drawn('column-rule')) ||
    (prop === '-webkit-text-stroke-color' && !['0px', undefined].includes(style['-webkit-text-stroke-width']));
}

/**
 * The sources the capture records for one element, per the CPO's round-18 fallback (main's own
 * per-owner wording): one per owner path in each state; owners of one selector that stated the same
 * changes are one source, as main collapses identical blocks to ×N; the element's own state is its
 * own source. Nothing is counted across owners.
 */
function sourcesOf(findings, nameOf) {
  const out = [];
  for (const state of new Set(findings.map((f) => f.state))) {
    const byOwner = new Map();
    for (const f of findings.filter((x) => x.state === state)) {
      const owner = f.path === stripPseudo(f.sub) ? '' : f.path;
      byOwner.set(owner, [...(byOwner.get(owner) ?? []), f]);
    }
    for (const [owner, changes] of byOwner) {
      const keys = changes.map(changeKey).sort();
      const label = owner ? labelOf(changes[0]) : '';
      const seen = out.find(
        (s) => s.state === state && owner && s.labels[0] === label && JSON.stringify(s.keys) === JSON.stringify(keys),
      );
      if (seen) {
        seen.owners.push(owner);
        continue;
      }
      out.push({
        state,
        own: !owner,
        owners: owner ? [owner] : [],
        labels: owner ? [label] : [],
        names: owner ? [nameOf(changes[0])] : [],
        props: [...new Set(changes.flatMap((c) => c.props.map((p) => propWord(p.prop))))],
        keys,
      });
    }
  }
  return out;
}
const shapeOf = (s) => JSON.stringify([s.state, s.own, s.labels, s.owners.length, s.keys]);

/** The change sections in a report.md or a PR comment, in order: title, sentence and fold lines. */
export function sectionsOf(md) {
  return md
    .split('\n### ')
    .slice(1)
    .map((chunk) => {
      const lines = chunk.split('\n');
      const sentence = lines.find((l, i) => i > 0 && /^[A-Z]/.test(l) && !l.startsWith('Show the CSS')) ?? '';
      const fold = lines.slice(lines.indexOf('<summary>Show the CSS</summary>') + 1);
      return { title: lines[0], sentence, fold };
    })
    .filter((s) => s.fold.length && s.fold.some((l) => /^`[^`]+` · \d+ elements? /.test(l)));
}

/**
 * A finding as the line states it: a property that moved exactly like the text colour is an echo
 * and not stated, unless the element draws it (QA16-01, QA17-03).
 */
function stated(f, draws) {
  const color = f.props.find((p) => p.prop === 'color');
  if (!color || /::/.test(f.sub)) return f;
  const echo = (p) =>
    p !== color && /color$/.test(p.prop) && p.before === color.before && p.after === color.after && !draws(p.prop);
  return { ...f, props: f.props.filter((p) => !echo(p)) };
}

/** Per report.json region: the first element's state findings and sources, and every element's shapes. */
export function truthOf(json, elements = {}) {
  const nameOf = nameIn(elements);
  return (json.surfaces ?? []).flatMap((surface) =>
    (surface.regions ?? []).map((region) => {
      const states = (surface.findings ?? []).filter((f) => f.kind === 'state');
      const forPath = (p) => states.filter((f) => stripPseudo(f.sub) === p);
      const saidFor = (p) => forPath(p).map((f) => stated(f, drawnColors(elements[p])));
      return {
        paths: region.paths,
        findings: forPath(region.paths[0]),
        sources: sourcesOf(saidFor(region.paths[0]), nameOf),
        shapes: region.paths.map((p) => sourcesOf(saidFor(p), nameOf).map(shapeOf).sort()),
      };
    }),
  );
}

/** The sentence's clauses: each "when …" with the property text before it. */
function clausesOf(sentence) {
  const out = [];
  let from = 0;
  // The owner phrase (code spans aside) never crosses a comma, a full stop or another "when", so a
  // bare "when hovered" stays its own phrase.
  const pattern = /[Ww]hen (?:((?:`[^`]*`|(?![Ww]hen )[^,.;`])+?) (?:is|are) )?([a-z]+)(?=[ ,.;])/g;
  for (const m of sentence.matchAll(pattern)) {
    if (!STATE_BY_WORD[m[2]]) continue;
    out.push({ text: sentence.slice(from, m.index), phrases: [m[1] ?? ''], state: STATE_BY_WORD[m[2]], said: m[0] });
    from = m.index + m[0].length;
  }
  return out;
}

/** Whether an owner phrase names exactly this source's owners: "`x` ×N", "`x`", or the owner's noun. */
function phraseFits(phrase, source) {
  const times = / ×(\d+)$/.exec(phrase);
  const count = Number(times?.[1] ?? 1);
  const codes = [...phrase.matchAll(/`([^`]+)`/g)].map((m) => m[1]).sort();
  if (codes.length) return source.owners.length === count && JSON.stringify(codes) === JSON.stringify(source.labels);
  const lower = phrase.toLowerCase();
  return !times && source.owners.length === 1 && source.names.some((n) => lower.includes(n));
}

/** Which source a clause names; null when none (or the wrong kind) fits. */
function sourceFor(clause, sources, taken) {
  const bare = clause.phrases.includes('');
  const driver = clause.phrases.find(Boolean);
  const fits = (s) =>
    s.state === clause.state && !taken.has(s) && s.own === bare && (driver ? phraseFits(driver, s) : !s.owners.length);
  // The clause's properties pick the source among those its owner words fit.
  const named = Object.entries(PROPERTY_WORDS)
    .filter(([, word]) => clause.text.includes(word))
    .map(([prop]) => prop);
  return sources.find((s) => fits(s) && named.every((p) => s.props.includes(p))) ?? sources.find(fits) ?? null;
}

/** Problems in the sentence: one clause per source, each naming every change its source made. */
function sentenceProblems(section, truth) {
  const out = [];
  out.push(...repeatedChanges(section.sentence));
  // The fallback (CPO, round 18): no counted wording and no tail, so no change can be left uncounted
  // or merely counted (QA17-01/02/04/05).
  const counted =
    /\b(?:one of the \d+|either of the \d+|any of the \d+|each changes|also changes?|and \d+ more)\b/.exec(
      section.sentence,
    );
  if (counted) out.push(`counted or tail wording "${counted[0]}": "${section.sentence}"`);
  // The element's own state is its own clause, never merged with a control's (QA16-02, QA17-04).
  if (/when [a-z]+ or when /.test(section.sentence))
    out.push(`the element's own state shares a control's clause: "${section.sentence}"`);
  const all = truth.findings.map((f) => `${f.path} :${f.state} [${f.props.map((p) => p.prop)}]`).join('; ');
  const clauses = clausesOf(section.sentence);
  const taken = new Set();
  for (const clause of clauses) {
    const source = sourceFor(clause, truth.sources, taken);
    if (!source) {
      out.push(`"${clause.said}" names no source the capture records; truth: ${all}`);
      continue;
    }
    taken.add(source);
    const who = [source.own ? 'the element' : '', ...source.owners].filter(Boolean).join(' + ');
    for (const [prop, word] of Object.entries(PROPERTY_WORDS))
      if (clause.text.includes(word) && !source.props.includes(prop))
        out.push(`"${clause.said}" carries ${prop}, which ${who} did not change`);
    // Every change the source made is named in its clause, a drawn colour included (QA17-01/03/05).
    for (const prop of source.props)
      if (PROPERTY_WORDS[prop] && !clause.text.includes(PROPERTY_WORDS[prop]))
        out.push(`"${clause.said}" drops ${who}'s ${prop} change`);
  }
  // Two clauses in one state read alike only for owners main cannot tell apart: one selector's blocks.
  const phrases = clauses.filter((c) => c.phrases[0]).map((c) => `${c.state} ${c.phrases[0]}`);
  for (const phrase of new Set(phrases.filter((p, i) => phrases.indexOf(p) !== i)))
    if (!/^\S+ `[^`]+`(?: ×\d+)?$/.test(phrase)) out.push(`two owners main tells apart read alike: "${phrase}"`);
  for (const source of truth.sources)
    if (!taken.has(source))
      out.push(
        `no clause for ${[source.own ? "the element's own" : '', ...source.owners].filter(Boolean).join(' + ')} :${source.state} [${source.props}]`,
      );
  return out;
}

/** The fold's owner blocks: heading label, ×N and its `:state[ ::pseudo] prop` rows. */
function blocksOf(fold) {
  const blocks = [];
  for (const line of fold) {
    const head = /^\*\*(?:[^*]+\*\* )?`([^`]+)`(?:\*\*)?(?: ×(\d+))?$/.exec(line);
    if (head) blocks.push({ label: head[1], count: Number(head[2] ?? 1), rows: [] });
    const row = /^\| `:([\w-]+)(?: (::[\w-]+))? ([\w-]+)`/.exec(line);
    if (row && blocks.length)
      blocks[blocks.length - 1].rows.push({ state: row[1], pseudo: row[2] ?? '', prop: row[3], line });
  }
  return blocks;
}

/** A row stands for a captured prop: the same longhand, or a shorthand over its longhands. */
const rowCovers = (row, state, sub, prop) =>
  row.state === state &&
  row.pseudo === pseudoOf(sub) &&
  (prop === row.prop || prop.startsWith(`${row.prop.split('-')[0]}-`));

/** Problems in "Show the CSS": one block per owner path, rows exactly its changes. */
function foldProblems(section, truth) {
  const out = [];
  const blocks = blocksOf(section.fold);
  // Rule 5 (QA13-03): no row repeats inside a block, and two identical blocks are one ×N block.
  for (const block of blocks) {
    const lines = block.rows.map((r) => r.line);
    if (new Set(lines).size !== lines.length)
      out.push(`identical CSS rows repeat in \`${block.label}\`: ${lines.join(' ')}`);
  }
  const bodies = blocks.filter((b) => b.rows.length).map((b) => `${b.label}\n${b.rows.map((r) => r.line).join('\n')}`);
  if (new Set(bodies).size !== bodies.length) out.push(`identical owner blocks repeat instead of one ×N block`);
  for (const block of blocks.filter((b) => b.rows.length)) {
    const owners = new Map();
    for (const f of truth.findings.filter((x) => labelOf(x) === block.label))
      owners.set(f.path, [...(owners.get(f.path) ?? []), f]);
    const covers = (findings) =>
      block.rows.every((r) => findings.some((f) => f.props.some((p) => rowCovers(r, f.state, f.sub, p.prop))));
    const matching = [...owners.values()].filter(covers).length;
    if (matching < block.count)
      out.push(
        `block \`${block.label}\`${block.count > 1 ? ` ×${block.count}` : ''} shows changes only ${matching} owner(s) of that label made`,
      );
  }
  for (const f of truth.findings) {
    const shown = blocks.some(
      (b) => b.label === labelOf(f) && b.rows.some((r) => f.props.some((p) => rowCovers(r, f.state, f.sub, p.prop))),
    );
    if (!shown) out.push(`the fold has no \`${labelOf(f)}\` block for ${f.path} :${f.state}${pseudoOf(f.sub)}`);
  }
  return out;
}

/** Every attribution problem in one section against the capture. */
function attributionProblems(section, truth) {
  const out = [...sentenceProblems(section, truth), ...foldProblems(section, truth)];
  // 4. Grouping: a line drawn from the first element is true of every element in the section.
  for (const [i, shapes] of truth.shapes.entries())
    if (JSON.stringify(shapes) !== JSON.stringify(truth.shapes[0]))
      out.push(`${truth.paths[i]} has other sources than the first element`);
  return out;
}

/**
 * Attribution problems in a rendered text (report.md or the PR comment's sections) against
 * report.json. `elements` (from `elementsIn(beforeDir, afterDir)`) gives buttons' and links' text,
 * the names a reader tells them by (QA14-07); without it owners are known by class word only.
 */
export function attributionCheck(text, json, label, elements = {}) {
  const sections = sectionsOf(text);
  const truths = truthOf(json, elements);
  if (sections.length !== truths.length)
    return [`${label}: ${sections.length} sections shown, report.json has ${truths.length} regions`];
  return sections.flatMap((section, i) =>
    attributionProblems(section, truths[i]).map((p) => `${label} / ${section.title}: ${p}`),
  );
}
