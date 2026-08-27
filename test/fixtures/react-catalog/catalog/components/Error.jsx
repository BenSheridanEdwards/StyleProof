import { LABELS } from '../data.js';

export function Error({ message = LABELS.error }) {
  return (
    <p role="alert" data-testid="error-state">
      {message}
    </p>
  );
}

export default Error;
