// #1299 oracle: every forced-state finding is attributed to the owner path the capture recorded.
//
// Truth is the capture's own record, keyed by OWNER PATH, never by selector label or class word:
// each state finding in report.json is (owner = `path`, state, target = `sub`, props). Owners share
// a source only when they produced a byte-identical change (same state, owner selector label and
// props), the rule main's ×N blocks follow. For each change section, the rendered text (report.md or
// a PR comment) must hold, for its first element:
//   1. one sentence clause per source, carrying only that source's properties; "either/any of the N"
//      only for a source of N owners; the element's own state said as its own ("when hovered");
//   2. clauses of different sources never read alike;
//   3. in "Show the CSS", one block per owner (main's renderer): each block's rows are exactly what
//      its owner changed, ×N only when N owners changed exactly that; no row repeats in a block, and
//      identical blocks are one ×N block;
//   4. grouping: every element in the section has sources of the same shape.
// Test-only.
import { prettyLabel } from '../dist/change-groups.js';
import { STATE_WORDS } from '../dist/report/change-line.js';

const STATE_BY_WORD = Object.fromEntries(Object.entries(STATE_WORDS).map(([state, word]) => [word, state]));
const stripPseudo = (sub) => sub.replace(/::[\w-]+$/, '');
/** Test vocabulary: a property as a change line names it, to read which properties a clause carries. */
const PROPERTY_WORDS = {
  'background-color': 'background',
  'border-color': 'border colour',
  color: 'text colour',
  'font-weight': 'text weight',
  'outline-color': 'outline colour',
};
const propsKey = (f) => JSON.stringify(f.props.map((p) => [p.prop, p.before, p.after]));
const labelOf = (f) => prettyLabel(f.path, f.cls ?? '');
const classWord = (cls) => (cls ?? '').split(/[\s_-]/)[0].toLowerCase();

/** The sources the capture records for one element: own per state; owners merged only when identical. */
function sourcesOf(findings) {
  const merged = new Map();
  for (const f of findings) {
    const own = f.path === stripPseudo(f.sub);
    const key = own ? `${f.state} own` : JSON.stringify([f.state, labelOf(f), propsKey(f)]);
    const seen = merged.get(key);
    if (seen && !own) seen.owners.push(f.path);
    else if (seen) seen.props.push(...f.props.map((p) => p.prop));
    else
      merged.set(key, {
        state: f.state,
        own,
        owners: own ? [] : [f.path],
        label: own ? '' : labelOf(f),
        word: classWord(f.cls),
        props: f.props.map((p) => p.prop),
        propsKey: propsKey(f),
      });
  }
  return [...merged.values()];
}
const shapeOf = (s) => JSON.stringify([s.state, s.label, s.owners.length, s.propsKey]);

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

/** Per report.json region: the first element's state sources, and every element's source shapes. */
export function truthOf(json) {
  return (json.surfaces ?? []).flatMap((surface) =>
    (surface.regions ?? []).map((region) => {
      const states = (surface.findings ?? []).filter((f) => f.kind === 'state');
      const forPath = (p) => states.filter((f) => stripPseudo(f.sub) === p);
      return {
        paths: region.paths,
        findings: forPath(region.paths[0]),
        sources: sourcesOf(forPath(region.paths[0])),
        shapes: region.paths.map((p) => sourcesOf(forPath(p)).map(shapeOf).sort()),
      };
    }),
  );
}

/** The sentence's clauses: each "when …" with the property text before it. */
function clausesOf(sentence) {
  const out = [];
  let from = 0;
  // The owner phrase (code spans aside) never crosses a comma, a full stop or another "when", so a
  // bare "when hovered" stays its own clause.
  const pattern = /when (?:((?:`[^`]*`|(?!when )[^,.;`])+?) is )?([a-z]+)(?=[ ,.;])/g;
  for (const m of sentence.matchAll(pattern)) {
    if (!STATE_BY_WORD[m[2]]) continue;
    out.push({ text: sentence.slice(from, m.index), phrase: m[1] ?? '', state: STATE_BY_WORD[m[2]], said: m[0] });
    from = m.index + m[0].length;
  }
  return out;
}

/** Which source a clause names, by the words it uses; null when none (or the wrong kind) fits. */
function sourceFor(clause, sources, taken) {
  const open = sources.filter((s) => s.state === clause.state && !taken.has(s));
  if (!clause.phrase) return open.find((s) => s.own) ?? null;
  const several = /^(?:either|any) of the (\d+) /.exec(clause.phrase);
  const code = /`([^`]+)`/.exec(clause.phrase)?.[1];
  const fits = (s) =>
    !s.own &&
    (several ? s.owners.length === Number(several[1]) : s.owners.length === 1) &&
    (code
      ? s.label === code
      : clause.phrase
          .toLowerCase()
          .split(/\W+/)
          .some((w) => w.startsWith(s.word)));
  // The clause's properties pick the source among those its owner words fit.
  const named = Object.entries(PROPERTY_WORDS)
    .filter(([, word]) => clause.text.includes(word))
    .map(([prop]) => prop);
  return open.find((s) => fits(s) && named.every((p) => s.props.includes(p))) ?? open.find(fits) ?? null;
}

/** Every attribution problem in one section against the capture. */
function attributionProblems(section, truth) {
  const out = [];
  const all = truth.findings.map((f) => `${f.path} :${f.state} [${f.props.map((p) => p.prop)}]`).join('; ');
  // 1. One clause per source, carrying only that source's properties.
  const clauses = clausesOf(section.sentence);
  const taken = new Set();
  for (const clause of clauses) {
    const source = sourceFor(clause, truth.sources, taken);
    if (!source) {
      out.push(`"${clause.said}" names no source the capture records; truth: ${all}`);
      continue;
    }
    taken.add(source);
    for (const [prop, word] of Object.entries(PROPERTY_WORDS))
      if (clause.text.includes(word) && !source.props.includes(prop))
        out.push(
          `"${clause.said}" carries ${prop}, which ${source.own ? 'the element' : source.owners.join(' + ')} did not change`,
        );
    if (
      source.props.some((p) => PROPERTY_WORDS[p]) &&
      !source.props.some((p) => clause.text.includes(PROPERTY_WORDS[p] ?? '\0'))
    )
      out.push(`"${clause.said}" names none of its source's properties (${source.props})`);
  }
  for (const source of truth.sources)
    if (!taken.has(source))
      out.push(
        `no clause for ${source.own ? "the element's own" : source.owners.join(' + ')} :${source.state} [${source.props}]`,
      );
  // 2. Clauses of different sources never read alike.
  const phrases = clauses.filter((c) => c.phrase).map((c) => `${c.state} ${c.phrase}`);
  if (new Set(phrases).size !== phrases.length) out.push(`two sources read alike: ${JSON.stringify(phrases)}`);
  // 3. The fold: one block per owner (×N only for N identical owners), rows exactly its changes.
  const blocks = [];
  for (const line of section.fold) {
    const head = /^\*\*(?:[^*]+\*\* )?`([^`]+)`(?:\*\*)?(?: ×(\d+))?$/.exec(line);
    if (head) blocks.push({ label: head[1], count: Number(head[2] ?? 1), rows: [] });
    const row = /^\| `:([\w-]+)` \| (?:↳ )?`([\w-]+)`/.exec(line);
    if (row && blocks.length) blocks[blocks.length - 1].rows.push({ state: row[1], prop: row[2], line });
  }
  // Rule 5 (QA13-03): no row repeats inside a block, and two identical blocks are one ×N block.
  // Two owners that each changed the colour keep a colour row each, under their own heading.
  for (const block of blocks) {
    const lines = block.rows.map((r) => r.line);
    if (new Set(lines).size !== lines.length)
      out.push(`identical CSS rows repeat in \`${block.label}\`: ${lines.join(' ')}`);
  }
  const bodies = blocks.filter((b) => b.rows.length).map((b) => `${b.label}\n${b.rows.map((r) => r.line).join('\n')}`);
  if (new Set(bodies).size !== bodies.length) out.push(`identical owner blocks repeat instead of one ×N block`);
  for (const block of blocks.filter((b) => b.rows.length)) {
    const owners = new Map();
    for (const f of truth.findings) {
      const own = f.path === stripPseudo(f.sub);
      const label = own ? prettyLabel(f.path, f.cls ?? '') : labelOf(f);
      if (label !== block.label) continue;
      owners.set(f.path, [...(owners.get(f.path) ?? []), ...f.props.map((p) => `${f.state} ${p.prop}`)]);
    }
    const covers = (changes) =>
      block.rows.every((r) =>
        changes.some((c) => c === `${r.state} ${r.prop}` || c.startsWith(`${r.state} ${r.prop.split('-')[0]}-`)),
      );
    const matching = [...owners.values()].filter(covers).length;
    if (matching < block.count)
      out.push(
        `block \`${block.label}\`${block.count > 1 ? ` ×${block.count}` : ''} shows changes only ${matching} owner(s) of that label made`,
      );
  }
  for (const f of truth.findings) {
    const label = labelOf(f);
    const shown = blocks.some(
      (b) =>
        b.label === label &&
        b.rows.some(
          (r) =>
            r.state === f.state &&
            f.props.some((p) => p.prop === r.prop || p.prop.startsWith(`${r.prop.split('-')[0]}-`)),
        ),
    );
    if (!shown) out.push(`the fold has no \`${label}\` block for ${f.path} :${f.state}`);
  }
  // 4. Grouping: a line drawn from the first element is true of every element in the section.
  for (const [i, shapes] of truth.shapes.entries())
    if (JSON.stringify(shapes) !== JSON.stringify(truth.shapes[0]))
      out.push(`${truth.paths[i]} has other sources than the first element`);
  return out;
}

/** Attribution problems in a rendered text (report.md or the PR comment's sections) against report.json. */
export function attributionCheck(text, json, label) {
  const sections = sectionsOf(text);
  const truths = truthOf(json);
  if (sections.length !== truths.length)
    return [`${label}: ${sections.length} sections shown, report.json has ${truths.length} regions`];
  return sections.flatMap((section, i) =>
    attributionProblems(section, truths[i]).map((p) => `${label} / ${section.title}: ${p}`),
  );
}
