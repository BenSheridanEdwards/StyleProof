import { LABELS } from '../data.js';

export function Empty({ message = LABELS.empty }) {
  return (
    <p className="is-empty" data-testid="empty-state">
      {message}
    </p>
  );
}

export default Empty;
