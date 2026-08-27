import { LABELS } from '../data.js';

export function Button({ label = LABELS.save, disabled = false, loading = false, error }) {
  return (
    <button type="button" data-testid="button" disabled={disabled || loading || Boolean(error)}>
      {error ? (
        <span data-testid="button-error">{error}</span>
      ) : loading ? (
        <span data-testid="button-loading">{LABELS.loading}</span>
      ) : (
        <span>{label}</span>
      )}
    </button>
  );
}

export default Button;
