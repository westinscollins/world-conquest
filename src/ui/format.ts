/** Money in US dollars; the game counts it in billions ($250M, $12B, $1.25T). */
export function money(v: number, opts: { sign?: boolean; digits?: number } = {}) {
  const a = Math.abs(v);
  const sign = v < 0 ? '−' : opts.sign ? '+' : '';
  if (a >= 1000) return `${sign}$${(a / 1000).toFixed(2)}T`;
  if (a > 0 && a < 1) return `${sign}$${Math.round(a * 1000)}M`;
  const d = opts.digits ?? (a < 10 ? 1 : 0);
  return `${sign}$${a.toFixed(d)}B`;
}
export const moneyIC = money;
export function num(v: number) {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + ' bn';
  if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1) + ' M';
  if (a >= 1e4) return (v / 1e3).toFixed(0) + 'k';
  return Math.round(v).toLocaleString('en-US');
}
export const pct = (v: number, d = 0) => `${(v * 100).toFixed(d)}%`;
export const cls = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');
/** A loss shown as a negative number ("−1,234"), or 0. */
export const neg = (v: number) => (v >= 1 ? `−${num(v)}` : '0');
