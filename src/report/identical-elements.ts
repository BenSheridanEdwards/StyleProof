import type { Finding } from '../diff.js';
import { signatureOf } from '../findings-clean.js';
import { prettyLabel, summarizeProps } from '../prop-summary.js';

/** Reuse the canonical change signature, replacing only element identity with its displayed label. */
export function elementChangeSignature(findings: Finding[]): string {
  const normalized = findings.map((finding) => {
    const label = prettyLabel(finding.path, finding.cls);
    const normalizedFinding = { ...finding, path: label };
    if (normalizedFinding.kind !== 'dom')
      normalizedFinding.props = [...normalizedFinding.props].sort((left, right) => left.prop.localeCompare(right.prop));
    if (normalizedFinding.kind === 'state' && finding.kind === 'state') {
      normalizedFinding.sub = finding.sub.startsWith(finding.path)
        ? label + finding.sub.slice(finding.path.length)
        : finding.sub;
    }
    return normalizedFinding;
  });
  // Surface signatures compare grid track counts across widths; element sections require exact values.
  const trackValues = normalized
    .flatMap((finding) =>
      finding.kind === 'dom'
        ? []
        : summarizeProps(finding.props)
            .filter((property) => ['grid-template-columns', 'grid-template-rows'].includes(property.prop))
            .map((property) =>
              JSON.stringify([finding.kind, finding.kind === 'state' ? finding.state : finding.pseudo, property]),
            ),
    )
    .sort();
  const domIdentity = normalized
    .filter((finding) => finding.kind === 'dom')
    .map((finding) =>
      JSON.stringify([
        finding.path,
        finding.detail ?? null,
        finding.component?.name ?? null,
        Object.entries(finding.component?.props ?? {}).sort(([left], [right]) => left.localeCompare(right)),
      ]),
    )
    .sort();
  return JSON.stringify([signatureOf(normalized), trackValues, domIdentity]);
}
