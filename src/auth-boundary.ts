/** Pure, privacy-safe classification of authentication boundaries observed in DOM metadata. */

export type AuthBoundaryMetadata = {
  /** A generated DOM selector; never a field value or text content. */
  selector?: string;
  inputType?: string | null;
  autocomplete?: string | null;
  formAction?: string | null;
  route?: string | null;
  redirectTo?: string | null;
  redirectStatus?: number | null;
  // Deliberately accepted structurally but never emitted: callers may pass raw DOM metadata.
  value?: unknown;
  text?: unknown;
};

type Redirect = {
  kind: 'auth-redirect';
  reason: 'auth-route-redirect';
  route?: string;
  redirectTo: string;
  redirectStatus: number;
};

export type AuthBoundaryDiagnostic =
  | { kind: 'credential-input'; reason: 'password-input' | 'credential-autocomplete'; selector?: string }
  | { kind: 'auth-form'; reason: 'auth-form-action'; selector?: string; formAction: string }
  | Redirect;

const CREDENTIAL_AUTOCOMPLETE = new Set(['username', 'current-password', 'new-password', 'one-time-code']);
/** Strong auth path segments only — generic `account` is excluded (false positives on ordinary account UIs). */
const AUTH_SEGMENT = /^(?:auth|authenticate|authentication|login|log-in|signin|sign-in|oauth|sso)$/i;
const REASON_ORDER = ['password-input', 'credential-autocomplete', 'auth-form-action', 'auth-route-redirect'];

/** Trimmed lower-case token, or '' for anything that is not a string. */
export const lowerToken = (value: unknown): string => (typeof value === 'string' ? value.trim().toLowerCase() : '');

/** Keep only a URL pathname. Queries, fragments, credentials, and opaque values are discarded. */
export function redactedPath(value: string | null | undefined): string | undefined {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!input || (!input.startsWith('/') && !/^https?:\/\//i.test(input))) return undefined;
  try {
    const pathname = new URL(input, 'https://styleproof.invalid').pathname || '/';
    return pathname.startsWith('/') ? pathname : undefined;
  } catch {
    return undefined;
  }
}

/** True when a redacted pathname contains a strong auth segment. Pathname only — redact first. */
export function isAuthPath(pathname: string | undefined | null): boolean {
  if (!pathname || typeof pathname !== 'string') return false;
  return pathname.split('/').some((segment) => AUTH_SEGMENT.test(segment));
}

/** Keep a generated structural selector, but reject any attribute-equality selector — quoted or
 *  unquoted — so field values cannot leak into diagnostics. */
export function redactedSelector(selector: string | undefined): string | undefined {
  if (typeof selector !== 'string' || !selector.trim() || selector.length > 200) return undefined;
  if (/\[[^\]]*[~|^$*]?=[^\]]*\]/.test(selector)) return undefined;
  // Defense in depth: bare `=…` value patterns outside brackets.
  if (/[=]["'`][^"'`]*["'`]/.test(selector) || /=\s*[^\s"'`\]]+/.test(selector)) return undefined;
  return selector.trim();
}

/** Deterministic order: by reason rank, then JSON identity. */
export function sortDiagnostics<T extends { reason: string }>(diagnostics: T[], order: readonly string[]): T[] {
  return diagnostics.sort(
    (a, b) => order.indexOf(a.reason) - order.indexOf(b.reason) || JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
}

function classifyCredentialInput(candidate: AuthBoundaryMetadata, selector?: string): AuthBoundaryDiagnostic[] {
  const sel = selector ? { selector } : {};
  const diagnostics: AuthBoundaryDiagnostic[] = [];
  if (lowerToken(candidate.inputType) === 'password') {
    diagnostics.push({ kind: 'credential-input', reason: 'password-input', ...sel });
  }
  if (CREDENTIAL_AUTOCOMPLETE.has(lowerToken(candidate.autocomplete))) {
    diagnostics.push({ kind: 'credential-input', reason: 'credential-autocomplete', ...sel });
  }
  return diagnostics;
}

function classifyAuthForm(candidate: AuthBoundaryMetadata, selector?: string): AuthBoundaryDiagnostic[] {
  const formAction = redactedPath(candidate.formAction);
  return formAction && isAuthPath(formAction)
    ? [{ kind: 'auth-form', reason: 'auth-form-action', ...(selector ? { selector } : {}), formAction }]
    : [];
}

function classifyAuthRedirect(candidate: AuthBoundaryMetadata): Redirect[] {
  const redirectTo = redactedPath(candidate.redirectTo);
  const redirectStatus = candidate.redirectStatus;
  const is3xx = typeof redirectStatus === 'number' && redirectStatus >= 300 && redirectStatus < 400;
  if (!redirectTo || !is3xx || !isAuthPath(redirectTo)) return [];
  const route = redactedPath(candidate.route);
  return [
    { kind: 'auth-redirect', reason: 'auth-route-redirect', ...(route ? { route } : {}), redirectTo, redirectStatus },
  ];
}

/** Classify DOM-derived metadata into deterministic diagnostics containing no secrets. */
export function classifyAuthBoundary(metadata: AuthBoundaryMetadata[]): AuthBoundaryDiagnostic[] {
  const diagnostics = metadata.flatMap((candidate) => {
    const selector = redactedSelector(candidate.selector);
    return [
      ...classifyCredentialInput(candidate, selector),
      ...classifyAuthForm(candidate, selector),
      ...classifyAuthRedirect(candidate),
    ];
  });
  return sortDiagnostics(diagnostics, REASON_ORDER);
}
