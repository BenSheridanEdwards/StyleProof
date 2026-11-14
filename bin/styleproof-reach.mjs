#!/usr/bin/env node
// Present reach remediation evidence; capture/gate integration is separate.
import fs from 'node:fs';
import { deriveReachGuards } from '../dist/reach-guard.js';
import { auditReach, readReachAckFile, reachKey } from '../dist/reach-ledger.js';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    'usage: styleproof reach --json [receipt.json]\nReads { units } remediation evidence from a file or stdin.',
  );
} else {
  try {
    if (args[0] !== '--json' || args.length > 2) throw new Error('usage: styleproof reach --json [receipt.json]');
    const receipt = JSON.parse(fs.readFileSync(args[1] ?? 0, 'utf8'));
    const ts = await import('typescript').then((module) => module.default).catch(() => null);
    const acknowledgements = readReachAckFile();
    const groups = Array.isArray(receipt.cases)
      ? receipt.cases.flatMap((c) =>
          Object.entries(c.scenarios).map(([scenario, result]) => ({
            case: c.id,
            scenario,
            units: result.evidence,
          })),
        )
      : [{ scenario: receipt.scenario, units: receipt.units }];
    const units = groups.flatMap((group) => {
      if (!Array.isArray(group.units) || !receipt.remediation)
        throw new Error('reach receipt requires units and remediation evidence');
      const evidence = {
        ...receipt.remediation,
        scenarios: {
          [group.scenario]: receipt.remediation.scenarios[group.scenario],
        },
      };
      return deriveReachGuards(
        group.units.filter((unit) => unit.status !== 'reached'),
        evidence,
        ts,
      ).map((row) => {
        const file = row.sourceKey ?? Object.keys(evidence.sources[row.side ?? 'head'] ?? {})[0] ?? 'styles.css';
        const key = reachKey(file, row.key);
        return {
          ...row,
          ...(group.case ? { case: group.case } : {}),
          scenario: group.scenario,
          reachKey: key,
          acknowledged: Boolean(acknowledgements[key]),
          ...(acknowledgements[key] ? { acknowledgement: acknowledgements[key] } : {}),
        };
      });
    });
    const audit = auditReach(
      units.filter((unit) => unit.status !== 'reached').map((unit) => unit.reachKey),
      acknowledgements,
    );
    console.log(JSON.stringify({ version: 1, units, audit }, null, 2));
    if (!audit.passed) process.exitCode = 1;
  } catch (error) {
    console.error(`styleproof reach: ${error.message}`);
    process.exitCode = 2;
  }
}
