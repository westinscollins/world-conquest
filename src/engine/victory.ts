import type { GameState } from './types';
import { ownedBy, livingNations, alliesOf } from './world';
import { NPROV, PROV, COUNTRY_GEO } from './geo';
import { addEvent } from './events';

export interface Achievement { id: string; name: string; desc: string; check: (s: GameState) => boolean; }
const P = (s: GameState) => s.nations[s.player];
export const ACHIEVEMENTS: Achievement[] = [
  { id: 'firstblood', name: 'First Blood', desc: 'Win your first battle.', check: (s) => P(s).stats.battlesWon >= 1 },
  { id: 'veteran', name: 'Veteran Commander', desc: 'Win 10 battles.', check: (s) => P(s).stats.battlesWon >= 10 },
  { id: 'underdog', name: 'Underdog', desc: 'Win a battle while outnumbered 2:1.', check: (s) => Object.values(s.battles).some((b) => b.result && ((b.result === 'attacker' && b.attacker.nation === s.player && b.defender.startStrength > b.attacker.startStrength * 2) || (b.result === 'defender' && b.defender.nation === s.player && b.attacker.startStrength > b.defender.startStrength * 2))) },
  { id: 'expansion', name: 'Expansion', desc: 'Own 10 provinces.', check: (s) => ownedBy(s, s.player).length >= 10 },
  { id: 'empire', name: 'Empire', desc: 'Own 50 provinces.', check: (s) => ownedBy(s, s.player).length >= 50 },
  { id: 'conqueror', name: 'Conqueror', desc: 'Annex an entire nation.', check: (s) => s.stats.annexations > 0 && P(s).stats.provincesCaptured > 0 },
  { id: 'banker', name: 'Central Banker', desc: 'Hold 1,000 M IC in the treasury.', check: (s) => P(s).treasury >= 1000 },
  { id: 'debtfree', name: 'Balanced Books', desc: 'Run a surplus for a full year with no debt.', check: (s) => P(s).debt === 0 && s.day > 365 && P(s).history.slice(-12).length >= 12 && P(s).history.slice(-12).every((h, i, a) => i === 0 || h.treasury >= a[i - 1].treasury) },
  { id: 'industrialist', name: 'Industrialist', desc: 'Own 30 factories.', check: (s) => ownedBy(s, s.player).reduce((t, p) => t + s.provinces[p].buildings.factory, 0) >= 30 },
  { id: 'scholar', name: 'Scholar', desc: 'Research 12 technologies.', check: (s) => P(s).research.done.length >= 12 },
  { id: 'diplomat', name: 'Grand Diplomat', desc: 'Have 3 alliances at once.', check: (s) => alliesOf(s, s.player).length >= 3 },
  { id: 'peacemaker', name: 'Peacemaker', desc: 'Sign 3 peace treaties.', check: (s) => s.timeline.filter((e) => e.kind === 'peace' && e.nations.includes(s.player)).length >= 3 },
  { id: 'overlord', name: 'Overlord', desc: 'Have a subject state.', check: (s) => livingNations(s).some((n) => n.overlord === s.player) },
  { id: 'survivor', name: 'Survivor', desc: 'Survive 10 years.', check: (s) => s.day >= 3650 && P(s).alive },
];

export function checkAchievements(s: GameState) {
  if (s.day % 7 !== 0) return;
  for (const a of ACHIEVEMENTS) {
    if (s.achievements[a.id] != null) continue;
    if (a.check(s)) {
      s.achievements[a.id] = s.day;
      addEvent(s, 'achievement', `Achievement unlocked: ${a.name} — ${a.desc}`, [s.player], { important: true });
    }
  }
}

export interface VictoryProgress { label: string; current: number; target: number; pct: number; }
export function victoryProgress(s: GameState): VictoryProgress[] {
  const v = s.settings.victory;
  const owned = ownedBy(s, s.player).length;
  const out = P(s).budget.output;
  const worldOut = livingNations(s).reduce((t, n) => t + n.budget.output, 0) || 1;
  const res: VictoryProgress[] = [];
  const add = (label: string, current: number, target: number) => res.push({ label, current, target, pct: Math.min(1, current / Math.max(1e-9, target)) });
  if (v.kind === 'domination') add('World provinces owned', owned, Math.ceil(NPROV * (v.provinceShare ?? 0.35)));
  if (v.kind === 'economic') add('Share of world output', out / worldOut, v.outputShare ?? 0.25);
  if (v.kind === 'hegemony') {
    const region = v.region ?? COUNTRY_GEO[s.player].subregion;
    const regionProvs = PROV.filter((p) => COUNTRY_GEO[p.country]?.subregion === region);
    const mine = regionProvs.filter((p) => s.provinces[p.id].owner === s.player).length;
    add(`Provinces of ${region}`, mine, Math.ceil(regionProvs.length * (v.regionShare ?? 0.6)));
  }
  if (v.kind === 'survival') add('Years survived', s.day / 365, v.years ?? 10);
  if (v.kind === 'custom') {
    if (v.customProvinces) add('Provinces owned', owned, v.customProvinces);
    if (v.customOutput) add('Annual output (M IC)', out, v.customOutput);
    if (v.customYears) add('Deadline (years remaining)', Math.max(0, v.customYears - s.day / 365), v.customYears);
  }
  return res;
}

export function checkVictory(s: GameState) {
  if (s.outcome) return;
  const p = P(s);
  if (!p.alive) {
    s.outcome = { won: false, day: s.day, reason: `${p.name} has been conquered.` };
    addEvent(s, 'war', s.outcome.reason, [s.player], { important: true });
    return;
  }
  if (s.day % 7 !== 0) return;
  const v = s.settings.victory;
  const prog = victoryProgress(s);
  if (v.kind === 'custom') {
    const goals = prog.filter((g) => !g.label.startsWith('Deadline'));
    if (goals.length && goals.every((g) => g.pct >= 1)) win(s, 'You achieved your custom objective.');
    else if (v.customYears && s.day / 365 > v.customYears) { s.outcome = { won: false, day: s.day, reason: 'The deadline for your objective has passed.' }; }
    return;
  }
  if (prog.length && prog[0].pct >= 1) {
    const reason = { domination: 'Global territorial dominance achieved.', economic: 'Economic supremacy achieved.', hegemony: 'Regional hegemony achieved.', survival: 'You survived against overwhelming odds.' }[v.kind];
    win(s, reason);
  }
}
function win(s: GameState, reason: string) {
  s.outcome = { won: true, day: s.day, reason };
  addEvent(s, 'achievement', `VICTORY: ${reason}`, [s.player], { important: true });
}
