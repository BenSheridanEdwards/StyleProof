import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CAPTURE_OUTCOMES_ENV, readCaptureTestOutcomes } from '../dist/map-store.js';
import { recordCaptureTestOutcomes } from '../dist/runner/surface-capture.js';

// styleproof-map publishes a partial baseline only when every failed capture test is a ledgered
// surface failure, so the runner must record each test's outcome — `running` until its afterEach
// runs, so a crashed worker reads as unexplained rather than as nothing.
// Created lazily by the first recorded outcome (never at collection time in the runner process).
const outcomesDir = path.join(os.tmpdir(), `sp-outcomes-${process.pid}-${Date.now()}`);

test.describe.serial('capture test outcomes', () => {
  // The hooks read the env var at define time; unset it at once so no other spec inherits it.
  process.env[CAPTURE_OUTCOMES_ENV] = outcomesDir;
  recordCaptureTestOutcomes();
  delete process.env[CAPTURE_OUTCOMES_ENV];

  test('home @ 900', () => {
    expect(true).toBe(true);
  });

  test('outcomes are recorded per test', () => {
    const byTitle = Object.fromEntries(readCaptureTestOutcomes(outcomesDir).map((o) => [o.title, o.status]));
    expect(byTitle).toEqual({ 'home @ 900': 'passed', 'outcomes are recorded per test': 'running' });
  });

  test.afterAll(() => fs.rmSync(outcomesDir, { recursive: true, force: true }));
});
