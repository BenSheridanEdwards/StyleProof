// Reach corpus fixture (bench/reach-corpus.json). A spec that only opens `/` never renders the
// fault overlay, the `status=bad` badge, dark mode, or the 1440px band, so a
// restyle confined to one of them is invisible to today's diff.
import './styles.css';
import card from './card.module.css';

// Module-scope class maps: these definitions run at load whether or not a branch renders them.
const TONES = { ok: 'tone-ok', bad: 'tone-red' };
const ALERT = { critical: 'tone-amber' };

const params = new URLSearchParams(location.search);
const probe = { fault: params.get('fault') === '1', status: params.get('status') ?? 'ok' };

function h(type, props, ...children) {
  if (typeof type === 'function') return type(props ?? {});
  const el = document.createElement(type);
  for (const [k, v] of Object.entries(props ?? {})) el.setAttribute(k === 'className' ? 'class' : k, v);
  for (const c of children.flat()) if (c) el.append(c);
  return el;
}

// Runtime CSS-in-JS: the rule is injected only when the component renders.
function hash(s) {
  let x = 0;
  for (const c of s) x = (x * 31 + c.charCodeAt(0)) | 0;
  return (x >>> 0).toString(36);
}
function styled(tag, css) {
  return (props, label) => {
    const cls = `css-${hash(css)}`;
    if (!document.getElementById(cls)) {
      const style = document.createElement('style');
      style.id = cls;
      style.textContent = `.${cls} { ${css} }`;
      document.head.append(style);
    }
    return h(tag, { className: `${props.className} ${cls}` }, label);
  };
}
const Probe = styled('span', 'color: #16a34a;');

function Indicator() {
  return h('span', { className: 'indicator sp-indicator' }, 'Probe A');
}

function FaultOverlay() {
  return h(
    'div',
    { className: 'panel panel--fault sp-fault-panel' },
    h('span', { className: `${ALERT.critical} sp-alert` }, '!'),
    h('span', { className: 'fault-badge sp-fault-badge' }, 'Fault'),
    h('span', { className: `${card.alert} sp-card-alert` }, 'Check probe'),
    Probe({ className: 'sp-probe' }, 'Probe B'),
    h(Indicator),
  );
}

function Badge({ status }) {
  return h('span', { className: status === 'ok' ? 'badge badge--ok sp-badge' : 'badge badge--bad sp-badge' }, status);
}

function reportError(err) {
  console.warn('render failed', err);
}

function App() {
  try {
    return h(
      'main',
      null,
      h('a', { className: 'link sp-link', href: '#docs' }, 'Docs'),
      h(Badge, { status: probe.status }),
      h('span', { className: `${probe.status === 'ok' ? TONES.ok : TONES.bad} sp-tone` }, 'Tone'),
      h('a', { className: 'tone-red sp-delete', href: '#delete' }, 'Delete'),
      h('div', { className: 'panel sp-panel' }, h(Indicator)),
      probe.fault && h(FaultOverlay),
    );
  } catch (err) {
    reportError(err);
    return null;
  }
}

document.getElementById('root').append(App());
