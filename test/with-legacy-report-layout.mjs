/** Pin the previous default so existing report.md wording tests stay stable. */
export function withLegacyReportLayout(generate) {
  return (opts) => generate({ ...opts, layout: opts.layout ?? 'legacy' });
}
