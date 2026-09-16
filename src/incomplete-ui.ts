/** Pure classification of blocked continuation. Never records field values or secret text. */
import { lowerToken, redactedSelector, sortDiagnostics } from './auth-boundary.js';

export type IncompleteUiMetadata = {
  /** A generated DOM selector; never a field value or text content. */
  selector?: string;
  tag?: string | null;
  role?: string | null;
  type?: string | null;
  disabled?: boolean;
  ariaDisabled?: boolean;
  inert?: boolean;
  /** Computed style says this control cannot receive pointer input. */
  pointerEventsNone?: boolean;
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
  | { kind: 'form'; reason: 'form-present'; selector?: string }
  | {
      kind: 'blocked-control';
      reason: 'disabled-control' | 'aria-disabled' | 'inert' | 'pointer-events-none';
      selector?: string;
    }
  | { kind: 'required-empty'; reason: 'required-input-empty'; selector?: string }
  | { kind: 'closed-disclosure'; reason: 'aria-collapsed' | 'details-closed'; selector?: string };

const REASON_ORDER: IncompleteUiDiagnostic['reason'][] = [
  'form-present',
  'disabled-control',
  'aria-disabled',
  'inert',
  'pointer-events-none',
  'required-input-empty',
  'aria-collapsed',
  'details-closed',
];

/** Boolean flags that block a control outright, in precedence order. */
const BLOCKED_FLAGS: [keyof IncompleteUiMetadata, 'disabled-control' | 'aria-disabled' | 'inert'][] = [
  ['disabled', 'disabled-control'],
  ['ariaDisabled', 'aria-disabled'],
  ['inert', 'inert'],
];

function withSelector<T extends IncompleteUiDiagnostic>(diagnostic: T, selector?: string): T {
  return selector ? { ...diagnostic, selector } : diagnostic;
}

function classifyForm(candidate: IncompleteUiMetadata, selector?: string): IncompleteUiDiagnostic[] {
  const form = lowerToken(candidate.tag) === 'form' || lowerToken(candidate.role) === 'form';
  return form ? [withSelector({ kind: 'form', reason: 'form-present' }, selector)] : [];
}

function classifyBlockedControl(candidate: IncompleteUiMetadata, selector?: string): IncompleteUiDiagnostic[] {
  const flag = BLOCKED_FLAGS.find(([key]) => candidate[key] === true);
  if (flag) return [withSelector({ kind: 'blocked-control', reason: flag[1] }, selector)];
  const tag = lowerToken(candidate.tag);
  const control =
    tag === 'button' ||
    lowerToken(candidate.role) === 'button' ||
    (tag === 'input' && ['button', 'submit', 'reset'].includes(lowerToken(candidate.type)));
  return control && candidate.pointerEventsNone === true
    ? [withSelector({ kind: 'blocked-control', reason: 'pointer-events-none' }, selector)]
    : [];
}

function classifyRequiredEmpty(candidate: IncompleteUiMetadata, selector?: string): IncompleteUiDiagnostic[] {
  return candidate.required === true && candidate.valuePresent === false
    ? [withSelector({ kind: 'required-empty', reason: 'required-input-empty' }, selector)]
    : [];
}

function classifyClosedDisclosure(candidate: IncompleteUiMetadata, selector?: string): IncompleteUiDiagnostic[] {
  if (candidate.ariaExpanded === false) {
    return [withSelector({ kind: 'closed-disclosure', reason: 'aria-collapsed' }, selector)];
  }
  return lowerToken(candidate.tag) === 'details' && candidate.detailsOpen === false
    ? [withSelector({ kind: 'closed-disclosure', reason: 'details-closed' }, selector)]
    : [];
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
  return sortDiagnostics(diagnostics, REASON_ORDER);
}
