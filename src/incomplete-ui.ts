/** Pure classification of blocked continuation. Never records field values or secret text. */

export type IncompleteUiMetadata = {
  /** A generated DOM selector; never a field value or text content. */
  selector?: string;
  tag?: string | null;
  role?: string | null;
  type?: string | null;
  disabled?: boolean;
  ariaDisabled?: boolean;
  inert?: boolean;
  required?: boolean;
  /** Whether a value exists. The value itself must never be supplied or copied. */
  valuePresent?: boolean;
  ariaExpanded?: boolean | null;
  detailsOpen?: boolean | null;
  // Accepted structurally so callers can pass raw metadata. Never emitted.
  value?: unknown;
  text?: unknown;
};

export type IncompleteUiDiagnostic =
  | {
      kind: 'form';
      reason: 'form-present';
      selector?: string;
    }
  | {
      kind: 'blocked-control';
      reason: 'disabled-control' | 'aria-disabled' | 'inert';
      selector?: string;
    }
  | {
      kind: 'required-empty';
      reason: 'required-input-empty';
      selector?: string;
    }
  | {
      kind: 'closed-disclosure';
      reason: 'aria-collapsed' | 'details-closed';
      selector?: string;
    };

function redactedSelector(selector: string | undefined): string | undefined {
  if (typeof selector !== 'string' || !selector.trim() || selector.length > 200) return undefined;
  if (/\[[^\]]*[~|^$*]?=[^\]]*\]/.test(selector)) return undefined;
  if (/[=]["'`][^"'`]*["'`]/.test(selector) || /=\s*[^\s"'`\]]+/.test(selector)) return undefined;
  return selector.trim();
}

function withSelector<T extends IncompleteUiDiagnostic>(diagnostic: T, selector: string | undefined): T {
  return selector ? { ...diagnostic, selector } : diagnostic;
}

function classifyForm(candidate: IncompleteUiMetadata, selector: string | undefined): IncompleteUiDiagnostic[] {
  const tag = typeof candidate.tag === 'string' ? candidate.tag.trim().toLowerCase() : '';
  const role = typeof candidate.role === 'string' ? candidate.role.trim().toLowerCase() : '';
  return tag === 'form' || role === 'form' ? [withSelector({ kind: 'form', reason: 'form-present' }, selector)] : [];
}

function classifyBlockedControl(
  candidate: IncompleteUiMetadata,
  selector: string | undefined,
): IncompleteUiDiagnostic[] {
  if (candidate.disabled === true)
    return [withSelector({ kind: 'blocked-control', reason: 'disabled-control' }, selector)];
  if (candidate.ariaDisabled === true)
    return [withSelector({ kind: 'blocked-control', reason: 'aria-disabled' }, selector)];
  if (candidate.inert === true) return [withSelector({ kind: 'blocked-control', reason: 'inert' }, selector)];
  return [];
}

function classifyRequiredEmpty(
  candidate: IncompleteUiMetadata,
  selector: string | undefined,
): IncompleteUiDiagnostic[] {
  return candidate.required === true && candidate.valuePresent === false
    ? [withSelector({ kind: 'required-empty', reason: 'required-input-empty' }, selector)]
    : [];
}

function classifyClosedDisclosure(
  candidate: IncompleteUiMetadata,
  selector: string | undefined,
): IncompleteUiDiagnostic[] {
  if (candidate.ariaExpanded === false)
    return [withSelector({ kind: 'closed-disclosure', reason: 'aria-collapsed' }, selector)];
  const tag = typeof candidate.tag === 'string' ? candidate.tag.trim().toLowerCase() : '';
  if (tag === 'details' && candidate.detailsOpen === false)
    return [withSelector({ kind: 'closed-disclosure', reason: 'details-closed' }, selector)];
  return [];
}

/** Classify blocked-continuation metadata. Auth secrets stay in classifyAuthBoundary. */
export function classifyIncompleteUi(metadata: IncompleteUiMetadata[]): IncompleteUiDiagnostic[] {
  const diagnostics = metadata.flatMap((candidate) => {
    const selector = redactedSelector(candidate.selector);
    return [
      ...classifyForm(candidate, selector),
      ...classifyBlockedControl(candidate, selector),
      ...classifyRequiredEmpty(candidate, selector),
      ...classifyClosedDisclosure(candidate, selector),
    ];
  });
  const rank: Record<IncompleteUiDiagnostic['reason'], number> = {
    'form-present': 0,
    'disabled-control': 1,
    'aria-disabled': 2,
    inert: 3,
    'required-input-empty': 4,
    'aria-collapsed': 5,
    'details-closed': 6,
  };
  return diagnostics.sort(
    (a, b) => rank[a.reason] - rank[b.reason] || JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
}
