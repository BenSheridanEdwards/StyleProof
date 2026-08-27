import { LABELS } from '../data.js';

export function Loading({ message = LABELS.loading }) {
  return (
    <p role="status" data-testid="loading-state">
      {message}
    </p>
  );
}

export default Loading;
