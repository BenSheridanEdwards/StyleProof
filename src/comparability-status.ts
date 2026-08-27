export type ProductStateComparabilityStatus = 'comparable' | 'incomparable' | 'unproven' | 'not-required';

const PRODUCT_STATE_COMPARABILITY_STATUSES = new Set<ProductStateComparabilityStatus>([
  'comparable',
  'incomparable',
  'unproven',
  'not-required',
]);

export function isProductStateComparabilityStatus(value: unknown): value is ProductStateComparabilityStatus {
  return (
    typeof value === 'string' && PRODUCT_STATE_COMPARABILITY_STATUSES.has(value as ProductStateComparabilityStatus)
  );
}
