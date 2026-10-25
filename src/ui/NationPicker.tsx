import { useMemo, useState } from 'react';
import { WORLD } from '../engine/geo';
import { ECON } from '../engine/config';
import { money, num } from './format';

/** Starting output estimate, same formula as the world setup. */
const startOutput = (gdp: number, pop: number) => ECON.OUTPUT_K * Math.pow(Math.max(500, gdp), ECON.OUTPUT_EXP) * (1 + 0.04 * Math.log10(pop / 1e6 + 1));
export const NATIONS = WORLD.countries.map((c) => ({ id: c.id, name: c.name, region: c.subregion, provinces: c.provinces.length, pop: c.pop, output: startOutput(c.gdp, c.pop) })).sort((a, b) => b.output - a.output);
const difficultyOf = (out: number) => (out > 2500 ? ['Easy', 'd-tutorial'] : out > 600 ? ['Medium', 'd-standard'] : out > 150 ? ['Hard', 'd-hard'] : ['Very hard', 'd-hard']);

export function NationPicker({ value, onChange, taken = {} }: { value: string | null; onChange: (id: string) => void; taken?: Record<string, string> }) {
  const [q, setQ] = useState('');
  const list = useMemo(() => NATIONS.filter((n) => !q || n.name.toLowerCase().includes(q.toLowerCase()) || n.region.toLowerCase().includes(q.toLowerCase())), [q]);
  return (
    <div className="nation-pick">
      <input id="nation-search" placeholder={`Search ${NATIONS.length} nations or regions…`} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="np-list">
        {list.map((n, i) => {
          const [d, cls] = difficultyOf(n.output);
          return (
            <button key={n.id} className={`np-row${value === n.id ? ' on' : ''}`} disabled={!!taken[n.id] && value !== n.id} title={taken[n.id] ? `Taken by ${taken[n.id]}` : undefined} onClick={() => onChange(n.id)}>
              <span className="np-rank">{NATIONS.indexOf(n) + 1}</span>
              <span className="np-name"><b>{n.name}</b><span>{n.region} · {n.provinces} province{n.provinces > 1 ? 's' : ''} · {num(n.pop)} people</span></span>
              <span className="np-out">{money(n.output)}</span>
              {taken[n.id] && value !== n.id ? <span className="diff taken">{taken[n.id]}</span> : <span className={`diff ${cls}`}>{d}</span>}
            </button>
          );
        })}
        {!list.length && <p className="muted small">No nation matches “{q}”.</p>}
      </div>
      <p className="small muted">Ranked by starting economy (yearly output in dollars). Smaller economies are harder starts.</p>
    </div>
  );
}

