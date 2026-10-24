// Reach cost fixture (#989): a JS-heavy React page, so V8 block coverage has real
// work to count. 300 rows of nested components with hooks, conditional branches
// and style objects, rendered synchronously at load.
import { useMemo, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import './styles.css';

const STATUSES = ['ok', 'warn', 'fault', 'idle'];
const TAGS = ['edge', 'core', 'lab'];
const rows = Array.from({ length: 300 }, (_, i) => ({
  id: i,
  name: `Probe ${i}`,
  status: STATUSES[i % STATUSES.length],
  load: (i * 37) % 100,
  tags: TAGS.slice(0, (i % TAGS.length) + 1),
}));

function Tag({ label }) {
  return <span className={`tag tag--${label}`}>{label}</span>;
}

function Meter({ value }) {
  const tone = value > 80 ? 'hot' : value > 50 ? 'warm' : 'cool';
  return <span className={`meter meter--${tone}`} style={{ width: `${value}%` }} />;
}

function Status({ status }) {
  if (status === 'fault') return <strong className="status status--fault">Fault</strong>;
  if (status === 'warn') return <em className="status status--warn">Warn</em>;
  return <span className={`status status--${status}`}>{status}</span>;
}

function Row({ row, selected }) {
  const tags = useMemo(() => row.tags.map((t) => <Tag key={t} label={t} />), [row.tags]);
  return (
    <tr className={selected ? 'row row--selected' : 'row'}>
      <td>{row.name}</td>
      <td>
        <Status status={row.status} />
      </td>
      <td>
        <Meter value={row.load} />
      </td>
      <td>{tags}</td>
    </tr>
  );
}

function App() {
  const [selected] = useState(7);
  const [filter] = useState('all');
  const visible = useMemo(() => rows.filter((r) => filter === 'all' || r.status === filter), [filter]);
  return (
    <main>
      <h1>Probes</h1>
      <table>
        <tbody>
          {visible.map((r) => (
            <Row key={r.id} row={r} selected={r.id === selected} />
          ))}
        </tbody>
      </table>
    </main>
  );
}

const root = createRoot(document.getElementById('root'));
flushSync(() => root.render(<App />));
