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

for (const [name, build] of Object.entries(cases)) {
  test(`owner truth: ${name}`, (t) => {
    const { md, json } = run(t, build);
    const findings = (json.surfaces ?? []).flatMap((s) => s.findings ?? []).filter((f) => f.kind === 'state');
    const sections = md
      .split('\n### ')
      .slice(1)
      .filter((s) => /when /.test(s));
    const regions = (json.surfaces ?? []).flatMap((s) => s.regions ?? []);
    assert.equal(sections.length, regions.length, `${name}: ${sections.length} sections, ${regions.length} regions`);
    sections.forEach((section, i) => {
      const target = regions[i].paths[0];
      const mine = findings.filter((f) => strip(f.sub) === target && f.path !== strip(f.sub));
      // Sources: one per owner path; owners with an identical (state, props) collapse, as main's ×N does.
      const sources = new Map();
      for (const f of mine) {
        const key = JSON.stringify([f.state, f.props.map((p) => [p.prop, p.before, p.after]).sort()]);
        sources.set(key, new Set([...(sources.get(key) ?? []), f.path]));
      }
      const truth = mine.map((f) => `${f.path} :${f.state} [${f.props.map((p) => p.prop)}]`).join('; ');
      const sentence = section.split('\n').find((l, j) => j > 0 && /^[A-Z]/.test(l) && /when /.test(l)) ?? '';
      const clauses = [...sentence.matchAll(new RegExp(`when (?:(.+?) is )?(${words})(?=[ ,.])`, 'g'))].filter(
        (m) => m[1],
      );
      // 1. "either/any of the N" only when N owners each produced the same whole change.
      for (const m of clauses) {
        const alternatives = /^(?:either|any) of the (\d+) /.exec(m[1]);
        if (alternatives)
          assert.ok(
            [...sources.values()].some((owners) => owners.size === Number(alternatives[1])),
            `${name}: "${m[0]}" but no ${alternatives[1]} owners produced one identical change; truth: ${truth}`,
          );
      }
      // 2. Each owner-path source gets its own clause (none merged, none dropped).
      assert.equal(
        clauses.length,
        sources.size,
        `${name}: ${clauses.length} driven clause(s) for ${sources.size} source(s); truth: ${truth}; sentence: ${sentence}`,
      );
      // 3. Two clauses in one state never name their (different) owners with the same words.
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
        const owners = mine.filter((f) => f.state === STATE_OF[m[2]]).map((f) => (f.cls ?? '').split(/[\s_-]/)[0]);
        assert.ok(
          owners.some((w) => w && m[1].toLowerCase().includes(w.toLowerCase())),
          `${name}: "${m[0]}" names no control that produced a :${STATE_OF[m[2]]} change; truth: ${truth}`,
        );
      }
      // 6. The element's own state reads as its own ("when hovered"), never under a control's clause.
      const ownStates = new Set(
        findings.filter((f) => strip(f.sub) === target && f.path === strip(f.sub)).map((f) => f.state),
      );
      const bare = new Set(
        [...sentence.matchAll(new RegExp(`when (${words})(?=[ ,.])`, 'g'))].map((m) => STATE_OF[m[1]]),
      );
      for (const state of ownStates)
        assert.ok(
          bare.has(state),
          `${name}: the element's own :${state} change is not said as its own; sentence: ${sentence}`,
        );
      // 4. CSS rows never repeat (rule 5).
      const rows = section.split('\n').filter((l) => /^\| `/.test(l));
      assert.equal(new Set(rows).size, rows.length, `${name}: identical CSS rows repeat: ${rows.join(' ')}`);
    });
  });
}
