// QA12-01 oracle: every forced-state finding is attributed to the control the capture recorded.
//
// The truth is the capture's own record, not the renderer: a state finding in report.json carries
// its owner (`path`, the element whose state was forced when that state was captured) and its
// target (`sub`, the element restyled). That is the attribution main renders, one property table
// per owner. A change section's sentence, CSS line and property rows must name exactly those
// owners: the element's own state reads "when hovered", one control's state "when the opt is
// checked", one control per grouped element "when the matching opt is checked", and several
// controls of one label behind one change "when either of the 2 opts is checked". No state is
// credited to a control that did not produce it, and no control is picked out of several. Test-only.
import { prettyLabel } from '../dist/change-groups.js';
import { STATE_WORDS } from '../dist/report/change-line.js';

const STATE_BY_WORD = Object.fromEntries(Object.entries(STATE_WORDS).map(([state, word]) => [word, state]));
/** The owner's distinctive word, as the sentence names it: "the opt", "the pick". */
const ownerWord = (cls) => (cls ?? '').split(/[\s_-]/)[0];
const stripPseudo = (sub) => sub.replace(/::[\w-]+$/, '');
/** The phrase names the owner: its class word, or a button's text, in any case or plural. */
const mentions = (phrase, word) =>
  phrase
    .toLowerCase()
    .split(' ')
    .some((w) => w === word.toLowerCase() || w === `${word.toLowerCase()}s` || w === `${word.toLowerCase()}es`);

/** The change sections in a report.md or a PR comment, in order, with their sentence, CSS line and rows. */
export function sectionsOf(md) {
  return md
    .split('\n### ')
    .slice(1)
    .map((chunk) => {
      const lines = chunk.split('\n');
      const sentence = lines.find((l, i) => i > 0 && /^[A-Z]/.test(l) && !l.startsWith('Show the CSS')) ?? '';
      const meta = lines.find((l) => /^`[^`]+` · \d+ elements? /.test(l)) ?? '';
      const rows = lines.filter((l) => /^\| `/.test(l)).map((l) => l.split(' | ')[0].replace(/^\| /, ''));
      return { title: lines[0], sentence, meta, rows };
    })
    .filter((s) => s.meta);
}

/** What report.json says: per region, the state findings of its first element, as (state, owner). */
export function truthOf(json) {
  return (json.surfaces ?? []).flatMap((surface) =>
    (surface.regions ?? []).map((region) => {
      const states = (surface.findings ?? []).filter((f) => f.kind === 'state');
      const forPath = (p) => states.filter((f) => stripPseudo(f.sub) === p);
      const first = forPath(region.paths[0]).map((f) => ({
        state: f.state,
        own: f.path === stripPseudo(f.sub),
        owner: f.path,
        cls: f.cls,
        props: f.props.map((p) => p.prop),
      }));
      return { paths: region.paths, first, forPath };
    }),
  );
}

/** Every attribution problem in one section against its truth. */
function attributionProblems(section, truth) {
  const out = [];
  const keyOf = (f) => `${f.state} ${f.own ? '(own)' : ownerWord(f.cls)}`;
  const want = [...new Set(truth.first.map(keyOf))].sort();
  // 1. The sentence: one "when …" per (state, source), naming the control only for a control's state.
  const said = [
    ...section.sentence.matchAll(
      /when (?:the (?:matching )?(.+?) is |(?:either|any) of the \d+ (.+?) is )?([a-z]+)(?=[ ,.;])/g,
    ),
  ]
    .filter((m) => STATE_BY_WORD[m[3]])
    .map((m) => {
      const state = STATE_BY_WORD[m[3]];
      const phrase = m[1] ?? m[2];
      if (!phrase) return `${state} (own)`;
      const owner = truth.first.find((f) => !f.own && f.state === state && mentions(phrase, ownerWord(f.cls)));
      return `${state} ${owner ? ownerWord(owner.cls) : `?${phrase}`}`;
    });
  if (JSON.stringify([...said].sort()) !== JSON.stringify(want))
    out.push(`sentence names ${JSON.stringify(said)}, the capture records ${JSON.stringify(want)}`);
  // 2. One control behind one change is never one of several picked: several are named together.
  for (const key of want) {
    const owners = new Set(truth.first.filter((f) => !f.own && keyOf(f) === key).map((f) => f.owner));
    if (owners.size > 1 && !new RegExp(`(?:either|any) of the ${owners.size} `).test(section.sentence))
      out.push(`${owners.size} controls produce "${key}", but the sentence does not name them all`);
  }
  // 3. The CSS line names each control with the states it produced, and nothing else.
  const driven = [
    ...new Set(truth.first.filter((f) => !f.own).map((f) => `${prettyLabel(f.owner, f.cls)} :${f.state}`)),
  ].sort();
  const metaPairs = [];
  let owner = null;
  for (const token of (section.meta.split(' · when ')[1] ?? '').split(', ')) {
    const m = /^(?:`([^`]+)` is )?`:([\w-]+)`$/.exec(token.trim());
    if (!m) continue;
    owner = m[1] ?? owner;
    metaPairs.push(`${owner} :${m[2]}`);
  }
  if (JSON.stringify(metaPairs.sort()) !== JSON.stringify(driven))
    out.push(`CSS line names ${JSON.stringify(metaPairs)}, the capture records ${JSON.stringify(driven)}`);
  // 4. Each state row names the control that produced it (none for the element's own state).
  for (const row of section.rows) {
    const m = /^`(?:(\S+?))?:([\w-]+) ([\w-]+)/.exec(row);
    if (!m) continue;
    const [, rowOwner, state, prop] = m;
    const match = truth.first.find(
      (f) =>
        f.state === state &&
        (rowOwner ? !f.own && prettyLabel(f.owner, f.cls) === rowOwner : f.own) &&
        f.props.some((p) => p === prop || p.startsWith(`${prop.split('-')[0]}-`)),
    );
    if (!match) out.push(`row ${row} names an owner no finding has for that property`);
  }
  // 5. Grouping: a line drawn from the first element is true of every element in the section.
  for (const p of truth.paths.slice(1)) {
    const others = [
      ...new Set(
        truth.forPath(p).map((f) => `${f.state} ${f.path === stripPseudo(f.sub) ? '(own)' : ownerWord(f.cls)}`),
      ),
    ].sort();
    if (JSON.stringify(others) !== JSON.stringify(want))
      out.push(`${p} has ${JSON.stringify(others)}, but the section line says ${JSON.stringify(want)}`);
  }
  return out;
}

/**
 * Attribution problems in a rendered text (report.md or the PR comment's sections) against
 * report.json. `sections` lets a caller check a text that carries only some sections.
 */
export function attributionCheck(text, json, label) {
  const sections = sectionsOf(text);
  const truths = truthOf(json);
  if (sections.length !== truths.length)
    return [`${label}: ${sections.length} sections shown, report.json has ${truths.length} regions`];
  return sections.flatMap((section, i) =>
    attributionProblems(section, truths[i]).map((p) => `${label} / ${section.title}: ${p}`),
  );
}
