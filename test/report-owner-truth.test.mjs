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
const changeKey = (f) =>
  JSON.stringify([
    f.state,
    (/::[\w-]+$/.exec(f.sub) ?? [''])[0],
    f.props.map((p) => [p.prop, p.before, p.after]).sort(),
  ]);

/**
 * The clauses the capture supports for one element, as the CPO's rule reads it (round 15):
 * - owners that made one identical change (same state, target, props) share a clause, whatever
 *   their selectors (QA14-06), and an element's own identical change joins it;
 * - a selector with several owner paths on the element whose names read alike cannot be told apart
 *   in the report (main heads them identically), so in each state its owners form ONE counted clause
 *   ("one of the N `input.chip` controls") instead of invented distinctions (QA14-01); owners a
 *   reader can tell apart by their text ("the Save button", "the Cancel button") keep their own;
 * - one owner's several changes in one state are one clause;
 * - every other owner gets its own clause.
 */
function expectedClauses(mine, nameOf) {
  const owners = new Map();
  for (const f of mine) owners.set(labelOf(f), new Set([...(owners.get(labelOf(f)) ?? []), f.path]));
  const alike = (label) => {
    const names = [...owners.get(label)].map((path) => nameOf(mine.find((f) => f.path === path)));
    return new Set(names).size < names.length;
  };
  const counted = new Set([...owners].filter(([label, paths]) => paths.size > 1 && alike(label)).map(([l]) => l));
  const clauses = [];
  for (const state of new Set(mine.map((f) => f.state))) {
    const identical = new Map();
    for (const f of mine.filter((x) => x.state === state))
      identical.set(changeKey(f), {
        owners: new Set([...(identical.get(changeKey(f))?.owners ?? []), f.path]),
        labels: new Set([...(identical.get(changeKey(f))?.labels ?? []), labelOf(f)]),
      });
    // One owner set's several changes are one source.
    const sources = new Map();
    for (const source of identical.values()) {
      const key = [...source.owners].sort().join('\0');
      if (sources.has(key)) source.labels.forEach((l) => sources.get(key).labels.add(l));
      else sources.set(key, source);
    }
    // Sources that share a counted selector become one clause.
    const groups = [];
    for (const source of sources.values()) {
      const shared = groups.find((g) => [...source.labels].some((l) => counted.has(l) && g.labels.has(l)));
      if (shared) {
        source.owners.forEach((o) => shared.owners.add(o));
        source.labels.forEach((l) => shared.labels.add(l));
        shared.sources += 1;
      } else groups.push({ state, owners: new Set(source.owners), labels: new Set(source.labels), sources: 1 });
    }
    clauses.push(...groups);
  }
  return { clauses, counted, owners };
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
      const all = findings.filter((f) => strip(f.sub) === target);
      const own = all.filter((f) => f.path === strip(f.sub));
      const mine = all.filter((f) => f.path !== strip(f.sub));
      const nameOf = nameIn(build(false).elements);
      const { clauses: expected, counted, owners } = expectedClauses(mine, nameOf);
      const truth = mine.map((f) => `${f.path} :${f.state} [${f.props.map((p) => p.prop)}]`).join('; ');
      const sentence = section.split('\n').find((l, j) => j > 0 && /^[A-Z]/.test(l) && /\b[Ww]hen /.test(l)) ?? '';
      const clauses = [
        ...sentence.matchAll(
          new RegExp(`[Ww]hen (?:((?:\`[^\`]*\`|(?![Ww]hen )[^,.;\`])+?) (?:is|are) )?(${words})(?=[ ,.])`, 'g'),
        ),
      ].filter((m) => m[1]);
      // 1. "either/any of the N" only when N owners each produced the same whole change.
      for (const m of clauses) {
        const alternatives = /^(?:either|any) of the (\d+) /.exec(m[1]);
        if (alternatives)
          assert.ok(
            expected.some(
              (c) => c.state === STATE_OF[m[2]] && c.sources === 1 && c.owners.size === Number(alternatives[1]),
            ),
            `${name}: "${m[0]}" but no ${alternatives[1]} owners produced one identical change; truth: ${truth}`,
          );
      }
      // 2. One clause per expected clause (none merged, none dropped).
      assert.equal(
        clauses.length,
        expected.length,
        `${name}: ${clauses.length} driven clause(s) for ${expected.length} expected; truth: ${truth}; sentence: ${sentence}`,
      );
      // 3. Two clauses in one state never name their owners with the same words.
      const byState = new Map();
      for (const m of clauses) byState.set(m[2], [...(byState.get(m[2]) ?? []), m[1]]);
      for (const [state, phrases] of byState)
        assert.equal(
          new Set(phrases).size,
          phrases.length,
          `${name}: two different owners in "${state}" read as one ("${phrases.join('" / "')}")`,
        );
      // 5. Each clause names an owner that produced a change in that state.
      for (const m of clauses) {
        const ownersHere = mine.filter((f) => f.state === STATE_OF[m[2]]).map(nameOf);
        assert.ok(
          ownersHere.some((w) => w && m[1].toLowerCase().includes(w.toLowerCase())),
          `${name}: "${m[0]}" names no control that produced a :${STATE_OF[m[2]]} change; truth: ${truth}`,
        );
      }
      // 7. No two different owners share a name (CPO, round 15): a singular name refers to exactly one
      // owner; a counted name ("one of the N `x` controls") to all N of that selector; "either/any of
      // the N" to exactly that clause's N owners; and one name text always refers to one set of owners.
      const referents = new Map();
      for (const m of clauses) {
        const state = STATE_OF[m[2]];
        const code = /`([^`]+)`/.exec(m[1])?.[1];
        const countedName = /^one of the (\d+) /.exec(m[1]);
        const several = /^(?:either|any) of the (\d+) /.exec(m[1]);
        const pool = mine.filter(
          (f) =>
            f.state === state && (code ? labelOf(f) === code : m[1].toLowerCase().includes(nameOf(f).toLowerCase())),
        );
        let set = countedName ? (owners.get(code) ?? new Set()) : new Set(pool.map((f) => f.path));
        // "either/any of the N": that clause's own N owners (QA15-02), never every owner of the selector,
        // and exactly one such owner set may fit the name.
        if (several) {
          const fits = expected.filter(
            (c) =>
              c.state === state &&
              c.sources === 1 &&
              c.owners.size === Number(several[1]) &&
              [...c.owners].every((p) => pool.some((f) => f.path === p)),
          );
          assert.equal(fits.length, 1, `${name}: "${m[0]}" fits ${fits.length} different owner sets; truth: ${truth}`);
          set = fits[0].owners;
        }
        if (countedName)
          assert.ok(
            code && counted.has(code) && set.size === Number(countedName[1]),
            `${name}: "${m[0]}" counts ${countedName[1]} but the capture has ${set.size} \`${code}\` owners`,
          );
        else if (!several)
          assert.equal(
            set.size,
            1,
            `${name}: "${m[0]}" names one control, but ${set.size} different owners fit that name; truth: ${truth}`,
          );
        // A selector with several owners here is never told apart by invented words ("one … another").
        if (code && counted.has(code))
          assert.ok(
            countedName || several,
            `${name}: "${m[0]}" singles out one of ${owners.get(code).size} \`${code}\` owners the report cannot tell apart`,
          );
        const key = m[1].replace(new RegExp(`\\b(${words})\\b`), '');
        const seen = referents.get(key);
        if (seen)
          assert.deepEqual([...set].sort(), [...seen].sort(), `${name}: "${m[1]}" names two different sets of owners`);
        referents.set(key, set);
      }
      // 8. One property change is said once in the sentence (QA14-06), whoever produced it.
      const fragments = [
        ...sentence.matchAll(/(?:the |, |and )([a-z][a-z ]+? changes from .+? to .+?)(?= when| and |, |\.)/g),
      ].map((m) => m[1].replace(/^(?:and )?(?:the )?/, ''));
      assert.equal(
        new Set(fragments).size,
        fragments.length,
        `${name}: one change is said twice: ${fragments.join(' / ')}`,
      );
      // 8b. Inside one clause, no owner group repeats another's changes, and no group says one twice
      // ("one changes the text colour …, while the other changes the text colour …"; QA16-01/03).
      assert.deepEqual(repeatedChanges(sentence), [], `${name}: ${sentence}`);
      // 6b. The element's own state never shares a counted clause's owner groups (QA16-02).
      assert.doesNotMatch(
        sentence,
        new RegExp(`when (?:${words}) or when one of the \\d+ `),
        `${name}: the element's own state sits under a counted clause: ${sentence}`,
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
