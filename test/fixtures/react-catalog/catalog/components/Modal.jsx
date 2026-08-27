import { LABELS } from '../data.js';

export function Modal({ title = LABELS.modalTitle, open = false }) {
  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true" data-testid="modal">
      <h2>{title}</h2>
      <p>{LABELS.modalBody}</p>
    </div>
  );
}

export default Modal;
