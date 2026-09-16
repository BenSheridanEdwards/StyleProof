export type ProductStateComparabilityStatus = 'comparable' | 'incomparable' | 'unproven' | 'not-required';

const STATUSES = new Set<string>(['comparable', 'incomparable', 'unproven', 'not-required']);

export function isProductStateComparabilityStatus(value: unknown): value is ProductStateComparabilityStatus {
  return typeof value === 'string' && STATUSES.has(value);
}

export type ComparabilityReceipt = { status: ProductStateComparabilityStatus; required: boolean };

export type ComparabilitySummary = {
  status: ProductStateComparabilityStatus;
  requireStateIdentity: boolean;
  blocksCertification: boolean;
  counts: {
    comparable: number;
    incomparable: number;
    unproven: number;
    notRequired: number;
    requiredUnproven: number;
    globalRequiredUnproven: number;
  };
};

/** Aggregate bounded receipts without promoting absent legacy identity to proof. */
export function summarizeComparability(
  receipts: readonly ComparabilityReceipt[],
  requireStateIdentity = false,
): ComparabilitySummary {
  // An unknown status (a hand-edited receipt) is treated as required-but-unproven so it fails closed.
  const normalized = receipts.map((entry) =>
    isProductStateComparabilityStatus(entry.status) ? entry : { status: 'unproven' as const, required: true },
  );
  const count = (test: (entry: ComparabilityReceipt) => boolean) => normalized.filter(test).length;
  const counts = {
    comparable: count((e) => e.status === 'comparable'),
    incomparable: count((e) => e.status === 'incomparable'),
    unproven: count((e) => e.status === 'unproven'),
    notRequired: count((e) => e.status === 'not-required'),
    requiredUnproven: count((e) => e.status === 'unproven' && e.required),
    globalRequiredUnproven: requireStateIdentity ? count((e) => e.status === 'unproven' && !e.required) : 0,
  };
  const status: ProductStateComparabilityStatus =
    counts.incomparable > 0
      ? 'incomparable'
      : counts.unproven > 0
        ? 'unproven'
        : counts.comparable > 0
          ? 'comparable'
          : 'not-required';
  return {
    status,
    requireStateIdentity,
    blocksCertification: counts.incomparable > 0 || counts.requiredUnproven > 0 || counts.globalRequiredUnproven > 0,
    counts,
  };
}
