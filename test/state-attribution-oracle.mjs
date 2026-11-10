// #1299 oracle: every forced-state finding is attributed to the owner path the capture recorded.
//
// Truth is the capture's own record, keyed by OWNER PATH, never by selector label or class word:
// each state finding in report.json is (owner = `path`, state, target = `sub`, props). The clauses
// the capture supports for one element follow the CPO's round-15 rule:
//   - one identical change (same state, pseudo-element and props) is one source, whichever owners
//     made it, the element's own state included (QA14-06);
//   - one owner's (or the element's own) several changes in one state are one source;
//   - owners of one selector label whose names read alike cannot be told apart in the report (main
//     heads them identically), so in each state they are ONE counted source, "one of the N `x`
//     controls" (QA14-01); a counted source of one identical change from all N reads "either/any of
//     the N". Owners a reader tells apart by name ("the Save button", "the Help link") keep their own.
// For each change section, the rendered text (report.md or a PR comment) must hold, for its first
// element:
//   1. one sentence clause per source, carrying only that source's properties, named by its owner's
//      name, selector label(s) or count, and the element's own state said as its own ("when hovered");
//   2. clauses of different sources never read alike;
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

/** One state's sources: identical changes merged, then one owner set's changes merged. */
function stateSourcesOf(findings) {
  const identical = new Map();
  for (const f of findings) {
    const own = f.path === stripPseudo(f.sub);
    const seen = identical.get(changeKey(f)) ?? { state: f.state, own: false, owners: new Set(), changes: [] };
    if (own) seen.own = true;
    else seen.owners.add(f.path);
    if (!seen.changes.some((c) => changeKey(c) === changeKey(f))) seen.changes.push(f);
    identical.set(changeKey(f), seen);
  }
  const byOwners = new Map();
  for (const source of identical.values()) {
    const key = JSON.stringify([source.own, [...source.owners].sort()]);
    const seen = byOwners.get(key);
    if (seen) seen.changes.push(...source.changes);
    else byOwners.set(key, source);
  }
  return [...byOwners.values()];
}

/** The sources the capture records for one element, per the rule above. */
function sourcesOf(findings, nameOf) {
  const driven = findings.filter((f) => f.path !== stripPseudo(f.sub));
  const ownersOf = new Map();
  for (const f of driven) ownersOf.set(labelOf(f), new Map([...(ownersOf.get(labelOf(f)) ?? []), [f.path, nameOf(f)]]));
  const counted = new Map(
    [...ownersOf]
      .filter(([, names]) => names.size > 1 && new Set(names.values()).size < names.size)
      .map(([label, names]) => [label, names.size]),
  );
  const out = [];
  for (const state of new Set(findings.map((f) => f.state))) {
    const groups = [];
    for (const source of stateSourcesOf(findings.filter((f) => f.state === state))) {
      const label = [...source.owners]
        .map((p) => labelOf(driven.find((f) => f.path === p)))
        .find((l) => counted.has(l));
      const group = label && groups.find((g) => g.counted?.label === label);
      if (group) {
        source.owners.forEach((o) => group.owners.add(o));
        group.changes.push(...source.changes);
        group.own ||= source.own;
      } else groups.push({ ...source, ...(label ? { counted: { label, total: counted.get(label) } } : {}) });
    }
    for (const g of groups) {
      // One identical change from all N owners of a counted selector reads "either/any of the N".
      if (g.counted && g.changes.length === 1 && g.owners.size === g.counted.total) delete g.counted;
      const owners = [...g.owners];
      const ownerFindings = owners.map((p) => driven.find((f) => f.path === p));
      out.push({
        state: g.state,
        own: g.own,
        owners,
        counted: g.counted,
        labels: [...new Set(ownerFindings.map(labelOf))].sort(),
        names: [...new Set(ownerFindings.map(nameOf))],
        props: [...new Set(g.changes.flatMap((c) => c.props.map((p) => propWord(p.prop))))],
        keys: g.changes.map(changeKey).sort(),
      });
    }
  }
  return out;
}
const shapeOf = (s) => JSON.stringify([s.state, s.own, s.labels, s.owners.length, s.counted?.total ?? 0, s.keys]);

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

/** Per report.json region: the first element's state findings and sources, and every element's shapes. */
export function truthOf(json, elements = {}) {
  const nameOf = nameIn(elements);
  return (json.surfaces ?? []).flatMap((surface) =>
    (surface.regions ?? []).map((region) => {
      const states = (surface.findings ?? []).filter((f) => f.kind === 'state');
      const forPath = (p) => states.filter((f) => stripPseudo(f.sub) === p);
      return {
        paths: region.paths,
        findings: forPath(region.paths[0]),
        sources: sourcesOf(forPath(region.paths[0]), nameOf),
        shapes: region.paths.map((p) => sourcesOf(forPath(p), nameOf).map(shapeOf).sort()),
      };
    }),
  );
}

/**
 * The sentence's clauses: each "when …" with the property text before it. "when hovered or when the
 * opt is hovered" is one clause with two phrases (the element's own state and an owner, one change).
 * A counted clause with owner groups leads with its trigger ("when one of the 2 `input.opt` controls
 * is checked, one changes …, while the other changes …"): its property text follows it.
 */
function clausesOf(sentence) {
  const out = [];
  let from = 0;
  // The owner phrase (code spans aside) never crosses a comma, a full stop or another "when", so a
  // bare "when hovered" stays its own phrase.
  const pattern = /when (?:((?:`[^`]*`|(?!when )[^,.;`])+?) (?:is|are) )?([a-z]+)(?=[ ,.;])/g;
  const matches = [...sentence.matchAll(pattern)].filter((m) => STATE_BY_WORD[m[2]]);
  for (const [i, m] of matches.entries()) {
    const end = m.index + m[0].length;
    const after = sentence.slice(end, matches[i + 1]?.index ?? sentence.length);
    const grouped = /^one of the \d+ `/.test(m[1] ?? '') && /^, (?:one|\d+ of them) changes? /.test(after);
    const text = grouped ? after.replace(/(?:, and |\. At rest.*)$/, '') : sentence.slice(from, m.index);
    const previous = out[out.length - 1];
    if (!grouped && previous && text.trim() === 'or' && previous.state === STATE_BY_WORD[m[2]]) {
      previous.phrases.push(m[1] ?? '');
      previous.said += ` or ${m[0]}`;
    } else out.push({ text, phrases: [m[1] ?? ''], state: STATE_BY_WORD[m[2]], said: m[0], grouped });
    from = grouped ? end + after.length : end;
  }
  return out;
}

/** Whether an owner phrase names exactly this source's owners. */
function phraseFits(phrase, source) {
  const counted = /^one of the (\d+) `([^`]+)` controls$/.exec(phrase);
  if (counted) return source.counted?.label === counted[2] && source.counted.total === Number(counted[1]);
  if (source.counted) return false;
  const several = /^(?:either|any) of the (\d+) /.exec(phrase);
  if (several) return source.owners.length === Number(several[1]) && source.names.some((n) => phrase.includes(n));
  const codes = [...phrase.matchAll(/`([^`]+)`/g)].map((m) => m[1]).sort();
  if (codes.length) return JSON.stringify(codes) === JSON.stringify(source.labels);
  const lower = phrase.toLowerCase();
  return source.owners.length === 1 && source.names.some((n) => lower.includes(n));
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

/** Problems in the sentence: one clause per source, each carrying only its source's properties. */
function sentenceProblems(section, truth) {
  const out = [];
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
    if (
      source.props.some((p) => PROPERTY_WORDS[p]) &&
      !source.props.some((p) => clause.text.includes(PROPERTY_WORDS[p] ?? '\0'))
    )
      out.push(`"${clause.said}" names none of its source's properties (${source.props})`);
  }
  for (const source of truth.sources)
    if (!taken.has(source))
      out.push(
        `no clause for ${[source.own ? "the element's own" : '', ...source.owners].filter(Boolean).join(' + ')} :${source.state} [${source.props}]`,
      );
  // 2. Clauses of different sources never read alike.
  const phrases = clauses.filter((c) => c.phrases.some(Boolean)).map((c) => `${c.state} ${c.phrases.join(' / ')}`);
  if (new Set(phrases).size !== phrases.length) out.push(`two sources read alike: ${JSON.stringify(phrases)}`);
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
