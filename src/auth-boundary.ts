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

export type AuthBoundaryDiagnostic =
  | {
      kind: 'credential-input';
      reason: 'password-input' | 'credential-autocomplete';
      selector?: string;
    }
  | {
      kind: 'auth-form';
      reason: 'auth-form-action';
      selector?: string;
      formAction: string;
    }
  | {
      kind: 'auth-redirect';
      reason: 'auth-route-redirect';
      route?: string;
      redirectTo: string;
      redirectStatus: number;
    };

const CREDENTIAL_AUTOCOMPLETE = new Set(['username', 'current-password', 'new-password', 'one-time-code']);
/** Strong auth path segments only — generic `account` is excluded (false positives on ordinary account UIs). */
const AUTH_SEGMENT = /^(?:auth|authenticate|authentication|login|log-in|signin|sign-in|oauth|sso)$/i;

/** Keep only a URL pathname. Queries, fragments, credentials, and opaque values are discarded. */
function redactedPath(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const input = value.trim();
  if (!input || (!input.startsWith('/') && !/^https?:\/\//i.test(input))) return undefined;
  try {
    const url = new URL(input, 'https://styleproof.invalid');
    const pathname = url.pathname || '/';
    return pathname.startsWith('/') ? pathname : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when a redacted pathname contains a strong auth segment (login, oauth, sso, …).
 * Shared by the classifier and crawl redirect retention — keep one definition.
 * Accepts pathname only; callers must redact query/fragment first.
 */
export function isAuthPath(pathname: string | undefined | null): boolean {
  if (!pathname || typeof pathname !== 'string') return false;
  return pathname
    .split('/')
    .filter(Boolean)
    .some((segment) => AUTH_SEGMENT.test(segment));
}

/**
 * Keep a generated structural selector, but reject any attribute equality selector —
 * quoted (`[value="…"]`) or unquoted (`[value=plaintext]`) — so field values cannot
 * leak into diagnostics. The classifier never reads or copies `value` or `text` fields.
 */
function redactedSelector(selector: string | undefined): string | undefined {
  if (typeof selector !== 'string' || !selector.trim() || selector.length > 200) return undefined;
  // Attribute selectors with a value binding (=, ~=, |=, ^=, $=, *=), any quoting style.
  if (/\[[^\]]*[~|^$*]?=[^\]]*\]/.test(selector)) return undefined;
  // Defense in depth: bare `=…` value patterns outside brackets.
  if (/[=]["'`][^"'`]*["'`]/.test(selector) || /=\s*[^\s"'`\]]+/.test(selector)) return undefined;
  return selector.trim();
}

function classifyCredentialInput(
  candidate: AuthBoundaryMetadata,
  selector: string | undefined,
): AuthBoundaryDiagnostic[] {
  const inputType = typeof candidate.inputType === 'string' ? candidate.inputType.trim().toLowerCase() : '';
  const autocomplete = typeof candidate.autocomplete === 'string' ? candidate.autocomplete.trim().toLowerCase() : '';
  const diagnostics: AuthBoundaryDiagnostic[] = [];
  if (inputType === 'password')
    diagnostics.push({ kind: 'credential-input', reason: 'password-input', ...(selector ? { selector } : {}) });
  if (CREDENTIAL_AUTOCOMPLETE.has(autocomplete))
    diagnostics.push({
      kind: 'credential-input',
      reason: 'credential-autocomplete',
      ...(selector ? { selector } : {}),
    });
  return diagnostics;
}

function classifyAuthForm(candidate: AuthBoundaryMetadata, selector: string | undefined): AuthBoundaryDiagnostic[] {
  const formAction = redactedPath(candidate.formAction);
  return formAction && isAuthPath(formAction)
    ? [{ kind: 'auth-form', reason: 'auth-form-action', ...(selector ? { selector } : {}), formAction }]
    : [];
}

function classifyAuthRedirect(candidate: AuthBoundaryMetadata): AuthBoundaryDiagnostic[] {
  const redirectTo = redactedPath(candidate.redirectTo);
  const redirectStatus = candidate.redirectStatus;
  if (
    !redirectTo ||
    typeof redirectStatus !== 'number' ||
    redirectStatus < 300 ||
    redirectStatus >= 400 ||
    !isAuthPath(redirectTo)
  )
    return [];
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
  const rank: Record<AuthBoundaryDiagnostic['reason'], number> = {
    'password-input': 0,
    'credential-autocomplete': 1,
    'auth-form-action': 2,
    'auth-route-redirect': 3,
  };
  return diagnostics.sort(
    (a, b) => rank[a.reason] - rank[b.reason] || JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
}
