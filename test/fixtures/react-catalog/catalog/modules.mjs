// The fixture dev entry's STATIC imports — the picture of what the catalog
// wires. StyleProof never loads modules itself: this registry is the
// consumer-owned truth the manifest is checked against. The provider module
// exists on disk but is intentionally NOT imported here (see missing-provider).
import * as Button from './components/Button.jsx';
import * as Modal from './components/Modal.jsx';
import * as Empty from './components/Empty.jsx';
import * as Loading from './components/Loading.jsx';
import * as ErrorState from './components/Error.jsx';

const BASE = 'test/fixtures/react-catalog/catalog';

export const MODULES = {
  [`${BASE}/components/Button.jsx`]: Button,
  [`${BASE}/components/Modal.jsx`]: Modal,
  [`${BASE}/components/Empty.jsx`]: Empty,
  [`${BASE}/components/Loading.jsx`]: Loading,
  [`${BASE}/components/Error.jsx`]: ErrorState,
};

// Export names come from the real static imports (Object.keys of the namespace
// — no AST, no eval, no dynamic import).
export const REGISTRY = Object.fromEntries(
  Object.entries(MODULES).map(([modulePath, namespace]) => [modulePath, { exports: Object.keys(namespace) }]),
);
