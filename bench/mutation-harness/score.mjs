// Pure parts of the mutation harness (bench/mutation-harness.mjs): target
// validation, mutation application, per-mutation scoring, run summary, and the
// history table. No browser, no server, no file system — unit-tested directly.
import { isUnder } from '../../dist/capture.js';

const DEFAULT_WIDTHS = [1280];
const DEFAULT_EXCLUDE = ['.git', 'node_modules'];
const DEFAULT_LINK = ['node_modules'];

const isText = (v) => typeof v === 'string' && v.length > 0;
const isTextList = (v) => Array.isArray(v) && v.every(isText);

/** Validate a target config and fill defaults. Throws one Error naming every problem. */
export function validateTarget(raw) {
  const problems = [];
  const need = (ok, message) => ok || problems.push(message);
  need(raw && typeof raw === 'object', 'target config must be a JSON object');
  if (problems.length) throw new Error(problems.join('\n'));

  need(isText(raw.name), '`name` must be a non-empty string');
  need(isText(raw.root), '`root` must be a non-empty path (relative to the config file)');
  const serve = raw.serve ?? {};
  need(
    isText(serve.static) !== isText(serve.command),
    '`serve` needs exactly one of `static` (dir to serve) or `command` (dev server command)',
  );
  if (isText(serve.command))
    need(isText(serve.url) && serve.url.includes('{port}'), '`serve.url` must contain `{port}`');
  need(Array.isArray(raw.pages) && raw.pages.length > 0, '`pages` must be a non-empty array');
  for (const [i, p] of (raw.pages ?? []).entries())
    need(isText(p?.key) && isText(p?.path) && p.path.startsWith('/'), `pages[${i}] needs \`key\` and a \`/path\``);
  const widths = raw.widths ?? DEFAULT_WIDTHS;
  need(
    Array.isArray(widths) && widths.length > 0 && widths.every((w) => Number.isInteger(w) && w > 0),
    '`widths` must be positive integers',
  );
  need(raw.ignore === undefined || isTextList(raw.ignore), '`ignore` must be a list of selectors');
  need(Array.isArray(raw.mutations) && raw.mutations.length > 0, '`mutations` must be a non-empty array');
  const ids = new Set();
  for (const [i, m] of (raw.mutations ?? []).entries()) {
    const at = `mutations[${i}]${isText(m?.id) ? ` (${m.id})` : ''}`;
    need(isText(m?.id) && !ids.has(m.id), `${at}: \`id\` must be a unique non-empty string`);
    ids.add(m?.id);
    need(isText(m?.file), `${at}: \`file\` must be a path relative to the target root`);
    need(isText(m?.find) && typeof m?.replace === 'string', `${at}: needs \`find\` and \`replace\` strings`);
    need(m?.find !== m?.replace, `${at}: \`find\` and \`replace\` are identical`);
    const e = m?.expect;
    need(
      e?.clean === true || isText(e?.selector),
      `${at}: \`expect\` needs \`selector\` (a change to detect) or \`clean: true\` (no finding expected)`,
    );
    need(e?.props === undefined || isTextList(e.props), `${at}: \`expect.props\` must be a list of property names`);
    need(e?.allow === undefined || isTextList(e.allow), `${at}: \`expect.allow\` must be a list of selectors`);
  }
  if (problems.length) throw new Error(problems.join('\n'));

  const copy = raw.copy ?? {};
  return {
    name: raw.name,
    root: raw.root,
    prepare: raw.prepare,
    serve: { settleMs: isText(serve.command) ? 1000 : 0, readyTimeoutMs: 60_000, ...serve },
    copy: {
      exclude: [...new Set([...DEFAULT_EXCLUDE, ...(copy.exclude ?? [])])],
      link: copy.link ?? DEFAULT_LINK,
    },
    pages: raw.pages,
    widths,
    ignore: raw.ignore ?? [],
    mutations: raw.mutations.map((m) => ({ category: 'other', ...m })),
  };
}

/** Apply one find/replace mutation. `find` must occur exactly once, so every run edits the same spot. */
export function applyMutation(source, mutation) {
  const count = source.split(mutation.find).length - 1;
  if (count !== 1)
    throw new Error(
      `mutation ${mutation.id}: \`find\` occurs ${count} times in ${mutation.file} (need exactly 1) — make it more specific`,
    );
  return source.replace(mutation.find, () => mutation.replace);
}

/** One flat finding shape across the style, state, dom, and advisory content layers. */
export function normalizeFindings(surface, styleFindings, contentChanges) {
  return [
    ...styleFindings.map((f) => ({
      surface,
      layer: f.kind,
      path: f.path,
      cls: f.cls,
      props: (f.props ?? []).map((p) => p.prop),
    })),
    ...contentChanges.map((c) => ({ surface, layer: c.kind, path: c.path, cls: c.cls, props: [] })),
  ];
}

const hasProp = (finding, props) =>
  !props?.length || finding.props.some((p) => props.some((want) => p === want || p.startsWith(`${want}-`)));

/**
 * Score one mutation. `targetPaths` / `allowPaths` map surface → element paths
 * the expected selectors resolved to; a finding on such an element (or inside
 * it) is expected. Everything else is stray: a false positive.
 *
 * - detected: some target finding carries an expected prop (any prop when none is declared)
 * - precision: expected findings / all findings (null when nothing was flagged)
 * - ok: detect → detected with zero stray findings; clean → zero findings
 */
export function scoreMutation(mutation, findings, targetPaths = {}, allowPaths = {}) {
  const under = (paths, f) => isUnder(f.path, paths[f.surface] ?? []);
  const onTarget = findings.filter((f) => under(targetPaths, f));
  const stray = findings.filter((f) => !under(targetPaths, f) && !under(allowPaths, f));
  const clean = mutation.expect.clean === true;
  const resolved = Object.values(targetPaths).some((paths) => paths.length > 0);
  const detected = !clean && onTarget.some((f) => hasProp(f, mutation.expect.props));

  let why;
  if (clean) why = findings.length ? `false positive — ${findings.length} finding(s)` : 'zero findings';
  else if (!resolved) why = `expect.selector ${mutation.expect.selector} matched no element on any page`;
  else if (!onTarget.length) why = 'missed — no finding on the target';
  else if (!detected) why = `imprecise — target findings lack props ${JSON.stringify(mutation.expect.props)}`;
  else why = `${onTarget.length} finding(s) on target`;
  if (!clean && stray.length) why += `; ${stray.length} stray`;

  return {
    id: mutation.id,
    category: mutation.category,
    expect: clean ? 'clean' : 'detect',
    ok: clean ? findings.length === 0 : detected && stray.length === 0,
    detected: clean ? null : detected,
    findings: findings.length,
    onTarget: onTarget.length,
    stray: stray.length,
    precision: findings.length ? (findings.length - stray.length) / findings.length : null,
    why,
    strayExamples: stray.slice(0, 3).map((f) => ({
      surface: f.surface,
      layer: f.layer,
      path: f.path,
      cls: f.cls,
      props: f.props.slice(0, 5),
    })),
  };
}

/** Run totals: detection rate over detect mutations, false-positive rate over all mutations. */
export function summarizeRun(results) {
  const detect = results.filter((r) => r.expect === 'detect');
  const precisions = results.map((r) => r.precision).filter((p) => p !== null);
  const runtimes = results.map((r) => r.runtimeMs).sort((a, b) => a - b);
  return {
    mutations: results.length,
    passed: results.filter((r) => r.ok).length,
    detected: `${detect.filter((r) => r.detected).length}/${detect.length}`,
    detectionRate: detect.length ? detect.filter((r) => r.detected).length / detect.length : null,
    falsePositiveRate: results.length ? results.filter((r) => r.stray > 0).length / results.length : null,
    meanPrecision: precisions.length ? precisions.reduce((a, b) => a + b, 0) / precisions.length : null,
    medianRuntimeMs: runtimes.length ? runtimes[Math.floor(runtimes.length / 2)] : null,
  };
}

const pct = (v) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`);

/** Human-readable lines for one run. */
export function formatRun(target, results, totals) {
  return [
    `StyleProof mutation harness — ${target} — ${totals.mutations} mutation(s)`,
    ``,
    ...results.map(
      (r) =>
        `  ${r.ok ? '✓' : '✗'} ${r.id} [${r.category}] ${r.why} — precision ${pct(r.precision)}, ${r.runtimeMs} ms`,
    ),
    ``,
    `  detection rate       ${pct(totals.detectionRate)} (${totals.detected})`,
    `  false-positive rate  ${pct(totals.falsePositiveRate)} (mutations with a stray finding)`,
    `  mean precision       ${pct(totals.meanPrecision)}`,
    `  median runtime       ${totals.medianRuntimeMs} ms per mutation`,
  ];
}

/** Table of logged runs, oldest first, so StyleProof versions line up for comparison. */
export function formatHistory(entries) {
  const rows = entries.map((e) => [
    e.at.slice(0, 19).replace('T', ' '),
    `${e.styleproof.version}@${e.styleproof.commit ?? '?'}${e.styleproof.dirty ? '+dirty' : ''}`,
    e.target.name,
    `${pct(e.totals.detectionRate)} (${e.totals.detected})`,
    pct(e.totals.falsePositiveRate),
    pct(e.totals.meanPrecision),
    `${e.totals.medianRuntimeMs} ms`,
  ]);
  const header = ['when (UTC)', 'styleproof', 'target', 'detection', 'false-pos', 'precision', 'median/mut'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells) =>
    cells
      .map((c, i) => c.padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  return [line(header), ...rows.map(line)];
}
