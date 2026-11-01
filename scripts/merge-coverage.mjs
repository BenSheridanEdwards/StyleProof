import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { matchesGlob } from 'node:path';
import { MERGED_COVERAGE_LINE_FLOOR, COVERAGE_INCLUDE, COVERAGE_EXCLUDE } from './check-coverage.mjs';

/** Union executable lines by source path; a hit in any shard covers the line. */
export function mergeCoverage(inputs, expected) {
  if (!Number.isSafeInteger(expected) || expected < 1 || inputs.length !== expected) {
    throw new Error('merge-coverage: expected input count mismatch');
  }
  const files = new Map();
  for (const input of inputs) {
    for (const [source, lines] of parseInput(input)) {
      if (!matchesGlob(source, COVERAGE_INCLUDE) || matchesGlob(source, COVERAGE_EXCLUDE)) {
        throw new Error(`merge-coverage: source outside coverage scope: ${source}`);
      }
      const merged = files.get(source) ?? new Map();
      for (const [line, hit] of lines) merged.set(line, merged.get(line) || hit);
      files.set(source, merged);
    }
  }
  const hits = [...files.values()].flatMap((lines) => [...lines.values()]);
  if (!hits.length) throw new Error('merge-coverage: no dist lines');
  return (100 * hits.filter(Boolean).length) / hits.length;
}

function addLine(row, lines) {
  const match = /^DA:([1-9]\d*),(\d+)(?:,[^,]+)?$/.exec(row);
  if (!lines || !match) throw new Error('merge-coverage: invalid line record');
  const line = Number(match[1]);
  const hits = Number(match[2]);
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(hits)) {
    throw new Error('merge-coverage: invalid line number or hits');
  }
  lines.set(line, lines.get(line) || hits > 0);
}

function sourcePath(row, previous) {
  if (previous) throw new Error('merge-coverage: unterminated record');
  const source = row.slice(3).replaceAll('\\', '/');
  if (!source) throw new Error('merge-coverage: empty source');
  return source;
}

function completeRecord(row, source, lines) {
  if (row !== 'end_of_record' || !source || !lines.size) {
    throw new Error('merge-coverage: empty or invalid record');
  }
  return [source, lines];
}

function* parseInput(input) {
  let source;
  let lines;
  let records = 0;
  for (const row of input.split(/\r?\n/)) {
    switch (row.split(':', 1)[0]) {
      case 'SF':
        source = sourcePath(row, source);
        lines = new Map();
        break;
      case 'DA':
        addLine(row, lines);
        break;
      case 'end_of_record':
        yield completeRecord(row, source, lines);
        records++;
        source = undefined;
        lines = undefined;
        break;
      default:
        if (row && !/^(TN|FN|FNDA|FNF|FNH|BRDA|BRF|BRH|LF|LH):/.test(row)) {
          throw new Error('merge-coverage: invalid lcov record');
        }
    }
  }
  if (source || !records) throw new Error('merge-coverage: incomplete or empty input');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [flag, count, ...paths] = process.argv.slice(2);
    if (flag !== '--expect') throw new Error('merge-coverage: use --expect N <lcov files>');
    const percent = Number(
      mergeCoverage(
        paths.map((file) => readFileSync(file, 'utf8')),
        Number(count),
      ).toFixed(2),
    );
    console.log(`Merged dist line coverage: ${percent.toFixed(2)}% (floor ${MERGED_COVERAGE_LINE_FLOOR}%)`);
    process.exitCode = percent < MERGED_COVERAGE_LINE_FLOOR ? 1 : 0;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
