// The #1299 class, keyed on what the capture records: every state finding in report.json is
// (owner path, state, target path, props). Truth is keyed by OWNER PATH, never by selector label,
// as main renders it (one block per owner path). Inputs: every wrong-control case from QA11
// (RV11-01), QA12-01 and QA13-01/02/03 (test/owner-truth-cases.mjs, from the round-13 diagnosis).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { generateStructuralStyleMapReportForTesting as generateReport } from '../dist/report.js';
import { STATE_WORDS } from '../dist/report/change-line.js';
import { makeMap, mkTmp, rmTmp, solidPng, writeCapture } from './helpers.mjs';
import { cases } from './owner-truth-cases.mjs';
import { repeatedChanges } from './rule5-detector.mjs';

function run(t, build) {
  const root = mkTmp('styleproof-owner-truth-');
  t.after(() => rmTmp(root));
  for (const side of ['before', 'after']) {
    const before = side === 'before';
    const dir = path.join(root, side);
    writeCapture(dir, 'form@390', makeMap(build(before)), solidPng(390, 220));
    for (const state of ['hover', 'focus', 'checked'])
      fs.writeFileSync(
        path.join(dir, `form@390.${state}.png`),
        solidPng(390, 220, before ? [20, 120, 60] : [160, 40, 40]),
      );
  }
  const result = generateReport({
    beforeDir: path.join(root, 'before'),
    afterDir: path.join(root, 'after'),
    outDir: path.join(root, 'report'),
  });
  return {
    md: fs.readFileSync(result.reportMdPath, 'utf8'),
    json: JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8')),
  };
}

const strip = (sub) => sub.replace(/::[\w-]+$/, '');
const words = Object.values(STATE_WORDS).join('|');
const STATE_OF = Object.fromEntries(Object.entries(STATE_WORDS).map(([state, word]) => [word, state]));
const tagOf = (p) => (p.split('>').pop() ?? '').trim().replace(/:nth-child\(\d+\)|:sp-key\([a-z0-9]+\)/g, '');
const wordOf = (f) => (f.cls ?? '').split(/[\s_-]/)[0] || tagOf(f.path);
/** The name a reader can tell an owner by: a button's or link's own text, else its class word or tag. */
const nameIn = (elements) => (f) => {
  const entry = elements[f.path];
  return entry?.text && /^(?:button|a)$/.test(entry.tag) ? entry.text : wordOf(f);
};
const labelOf = (f) => ((f.cls ?? '').split(/\s+/)[0] ? `${tagOf(f.path)}.${f.cls.split(/\s+/)[0]}` : tagOf(f.path));
/** The colours an element draws (a border, outline, column rule or text stroke with a style and width). */
function drawnColors(style = {}) {
  const drawn = (part) =>
    !['none', 'hidden', undefined].includes(style[`${part}-style`]) && style[`${part}-width`] !== '0px';
  return (prop) =>
    (/^border-\w+-color$/.test(prop) && ['top', 'right', 'bottom', 'left'].some((s) => drawn(`border-${s}`))) ||
    (prop === 'outline-color' && drawn('outline')) ||
    (prop === 'column-rule-color' && drawn('column-rule')) ||
    (prop === '-webkit-text-stroke-color' && !['0px', undefined].includes(style['-webkit-text-stroke-width']));
}
/** A finding without the colour echoes its line does not state; a colour the element draws is stated. */
function statedOf(f, draws) {
  const color = f.props.find((p) => p.prop === 'color');
  if (!color || /::/.test(f.sub)) return f;
  const echo = (p) =>
    p !== color && /color$/.test(p.prop) && p.before === color.before && p.after === color.after && !draws(p.prop);
  return { ...f, props: f.props.filter((p) => !echo(p)) };
}
const changeKey = (f) =>
  JSON.stringify([
    f.state,
    (/::[\w-]+$/.exec(f.sub) ?? [''])[0],
    f.props.map((p) => [p.prop, p.before, p.after]).sort(),
  ]);
/** Test vocabulary: a property as a change line names it. */
const PROPERTY_WORDS = {
  'background-color': 'background',
  color: 'text colour',
  'border-color': 'border colour',
  'outline-color': 'outline colour',
  'font-weight': 'text weight',
  'font-size': 'text size',
};
const propWord = (prop) => PROPERTY_WORDS[prop.replace(/^border-(?:top|right|bottom|left)-color$/, 'border-color')];

/**
 * The clauses the capture supports for one element, per the CPO's round-18 fallback (main's own
 * per-owner wording): one clause per owner path, as main heads one block per owner path; owners of
 * one selector that stated the same changes are one clause, as main collapses identical blocks to
 * ×N; the element's own state is its own clause (checked separately); one owner's several changes
 * in one state are one clause. Nothing is counted across owners and nothing goes in a tail.
 */
function expectedClauses(mine) {
  const blocks = [];
  for (const state of new Set(mine.map((f) => f.state))) {
    const byOwner = new Map();
    for (const f of mine.filter((x) => x.state === state)) byOwner.set(f.path, [...(byOwner.get(f.path) ?? []), f]);
    for (const [owner, changes] of byOwner) {
      const key = JSON.stringify([labelOf(changes[0]), changes.map(changeKey).sort()]);
      const seen = blocks.find((b) => b.state === state && b.key === key);
      if (seen) seen.owners.add(owner);
      else
        blocks.push({
          state,
          key,
          label: labelOf(changes[0]),
          owners: new Set([owner]),
          words: [...new Set(changes.flatMap((f) => f.props.map((p) => propWord(p.prop))).filter(Boolean))],
        });
    }
  }
  return blocks;
}

for (const [name, build] of Object.entries(cases)) {
  test(`owner truth: ${name}`, (t) => {
    const { md, json } = run(t, build);
    const findings = (json.surfaces ?? []).flatMap((s) => s.findings ?? []).filter((f) => f.kind === 'state');
    const sections = md
      .split('\n### ')
      .slice(1)
      .filter((s) => /\b[Ww]hen /.test(s));
    const regions = (json.surfaces ?? []).flatMap((s) => s.regions ?? []);
    assert.equal(sections.length, regions.length, `${name}: ${sections.length} sections, ${regions.length} regions`);
    sections.forEach((section, i) => {
      const target = regions[i].paths[0];
      // The changes the line states: an echo of the text colour is not stated, unless the element
      // draws it (a border, outline, column rule or text stroke; QA16-01, QA17-03).
      const draws = drawnColors(build(false).elements[target]?.style);
      const all = findings.filter((f) => strip(f.sub) === target).map((f) => statedOf(f, draws));
      const own = all.filter((f) => f.path === strip(f.sub));
      const mine = all.filter((f) => f.path !== strip(f.sub));
      const nameOf = nameIn(build(false).elements);
      const expected = expectedClauses(mine);
      const truth = mine.map((f) => `${f.path} :${f.state} [${f.props.map((p) => p.prop)}]`).join('; ');
      const sentence = section.split('\n').find((l, j) => j > 0 && /^[A-Z]/.test(l) && /\b[Ww]hen /.test(l)) ?? '';
      const clauses = [
        ...sentence.matchAll(
          new RegExp(`[Ww]hen (?:((?:\`[^\`]*\`|(?![Ww]hen )[^,.;\`])+?) (?:is|are) )?(${words})(?=[ ,.])`, 'g'),
        ),
      ].filter((m) => m[1]);
      // 1. No counted wording and no tail (the CPO's round-18 fallback, QA17-01/02/04): a change is
      // named in its owner's clause or not at all, so "and N more" can only hide one.
      assert.doesNotMatch(
        sentence,
        /\b(?:one of the \d+|either of the \d+|any of the \d+|each changes|also changes?|and \d+ more)\b/,
        `${name}: counted or tail wording: ${sentence}`,
      );
      // 2. One clause per owner path (owners of one selector that stated the same changes are one, ×N).
      assert.equal(
        clauses.length,
        expected.length,
        `${name}: ${clauses.length} driven clause(s) for ${expected.length} owner blocks; truth: ${truth}; sentence: ${sentence}`,
      );
      // 5. Each clause names an owner that produced a change in that state.
      for (const m of clauses) {
        const ownersHere = mine.filter((f) => f.state === STATE_OF[m[2]]).map(nameOf);
        assert.ok(
          ownersHere.some((w) => w && m[1].toLowerCase().includes(w.toLowerCase())),
          `${name}: "${m[0]}" names no control that produced a :${STATE_OF[m[2]]} change; truth: ${truth}`,
        );
      }
      // 7. Names as main gives them: "`x` ×N" is exactly a block of N `x` owners; "`x`" is one
      // owner of `x`; a plain noun ("the opt", "the Save button") names exactly one owner path.
      for (const m of clauses) {
        const state = STATE_OF[m[2]];
        const code = /`([^`]+)`/.exec(m[1])?.[1];
        const times = / ×(\d+)$/.exec(m[1]);
        const here = expected.filter((block) => block.state === state);
        if (code)
          assert.ok(
            here.some((block) => block.label === code && block.owners.size === Number(times?.[1] ?? 1)),
            `${name}: "${m[0]}" is no block of ${times?.[1] ?? 1} \`${code}\` owner(s); truth: ${truth}`,
          );
        else {
          const fits = here.filter((block) =>
            [...block.owners].some((p) =>
              m[1].toLowerCase().includes(nameOf(mine.find((f) => f.path === p)).toLowerCase()),
            ),
          );
          assert.equal(fits.length, 1, `${name}: "${m[0]}" fits ${fits.length} owner blocks; truth: ${truth}`);
          assert.equal(fits[0].owners.size, 1, `${name}: "${m[0]}" names one owner for ${fits[0].owners.size}`);
        }
      }
      // 8. Every change an owner made is named in its own clause, drawn colours included: nothing is
      // left to a tail or pruned as an echo when the element draws it (QA17-01/03/05).
      let from = 0;
      const texts = [];
      for (const m of sentence.matchAll(
        new RegExp(`[Ww]hen (?:((?:\`[^\`]*\`|(?![Ww]hen )[^,.;\`])+?) (?:is|are) )?(${words})(?=[ ,.])`, 'g'),
      )) {
        texts.push({ phrase: m[1] ?? '', state: STATE_OF[m[2]], text: sentence.slice(from, m.index) });
        from = m.index + m[0].length;
      }
      for (const block of expected) {
        const said = texts.filter((c) => c.state === block.state && c.phrase);
        assert.ok(
          said.some((c) => block.words.every((w) => c.text.includes(w))),
          `${name}: no clause names all of ${[...block.owners].join(' + ')}'s :${block.state} changes (${block.words}); sentence: ${sentence}`,
        );
      }
      // 3. Two clauses in one state may read alike only for owners main cannot tell apart either: two
      // blocks of one selector, named by that selector (QA14-01, round-18 fallback).
      const byPhrase = new Map();
      for (const m of clauses) {
        const key = `${m[2]} ${m[1]}`;
        byPhrase.set(key, [...(byPhrase.get(key) ?? []), m]);
      }
      for (const [key, alike] of byPhrase)
        if (alike.length > 1) {
          const code = /^`([^`]+)`(?: ×\d+)?$/.exec(alike[0][1])?.[1];
          assert.ok(
            code &&
              expected.filter((b) => b.state === STATE_OF[alike[0][2]] && b.label === code).length >= alike.length,
            `${name}: "${key}" reads alike for owners main tells apart; truth: ${truth}`,
          );
        }
      // 6d. The element's own state is said exactly once per state: one bare clause each.
      assert.equal(
        texts.filter((c) => !c.phrase).length,
        new Set(own.map((f) => f.state)).size,
        `${name}: the element's own states are not each said once; sentence: ${sentence}`,
      );
      // 6c. The element's own state names every change it made in its own clause.
      for (const state of new Set(own.map((f) => f.state))) {
        const ownWords = [
          ...new Set(own.filter((f) => f.state === state).flatMap((f) => f.props.map((p) => propWord(p.prop)))),
        ].filter(Boolean);
        const bareText = texts.filter((c) => c.state === state && !c.phrase);
        assert.ok(
          bareText.some((c) => ownWords.every((w) => c.text.includes(w))),
          `${name}: the element's own :${state} clause does not name all of ${ownWords}; sentence: ${sentence}`,
        );
      }
      // 8b. Inside one clause, no owner group repeats another's changes, and no group says one twice
      // ("one changes the text colour …, while the other changes the text colour …"; QA16-01/03).
      assert.deepEqual(repeatedChanges(sentence), [], `${name}: ${sentence}`);
      // 6b. The element's own state is its own clause, never merged with a control's (QA16-02, QA17-04).
      assert.doesNotMatch(
        sentence,
        new RegExp(`when (?:${words}) or when `),
        `${name}: the element's own state shares a control's clause: ${sentence}`,
      );
      // 9. A change on a pseudo-element is said as one (QA14-05).
      for (const pseudo of new Set(all.map((f) => (/::[\w-]+$/.exec(f.sub) ?? [''])[0]).filter(Boolean)))
        assert.ok(sentence.includes(pseudo), `${name}: the ${pseudo} change is not said as one; sentence: ${sentence}`);
      // 6. The element's own state reads as its own ("when hovered"), never under a control's clause.
      const bare = new Set(
        [...sentence.matchAll(new RegExp(`when (${words})(?=[ ,.])`, 'g'))].map((m) => STATE_OF[m[1]]),
      );
      for (const state of new Set(own.map((f) => f.state)))
        assert.ok(
          bare.has(state),
          `${name}: the element's own :${state} change is not said as its own; sentence: ${sentence}`,
        );
      // 4. CSS rows never repeat inside one owner's block (rule 5); two owners may each list a row.
      const blocks = section.split(/\n(?=\*\*)/).map((b) => b.split('\n').filter((l) => /^\| `/.test(l)));
      for (const rows of blocks)
        assert.equal(
          new Set(rows).size,
          rows.length,
          `${name}: identical CSS rows repeat in one block: ${rows.join(' ')}`,
        );
    });
  });
}
