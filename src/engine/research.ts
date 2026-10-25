import { govMods, registerTechCost } from './policy';
import type { GameState, Nation, TechMods } from './types';
import { ECON } from './config';
import { addEvent } from './events';
import { ownedBy } from './world';

export interface Tech {
  id: string; name: string; branch: string; tier: number; cost: number; requires: string[]; effect: string;
  apply: (m: TechMods) => void;
}

export const BRANCHES = ['Civilian Industry', 'Military Production', 'Logistics', 'Communications & Recon', 'Armor & Vehicles', 'Aviation & Naval', 'Medicine', 'Administration'];

// Research points (RP)/yr = 5 * funding^0.6 + labs: $2B/yr ≈ 7.6 RP, 20 M ≈ 30 RP. Diminishing returns stop rich nations finishing the tree instantly.
export const TECHS: Tech[] = [
  // Civilian industry
  { id: 'assembly', name: 'Assembly Line Methods', branch: 'Civilian Industry', tier: 1, cost: 8, requires: [], effect: '+8% factory capacity', apply: (m) => { m.industry += 0.08; } },
  { id: 'electrify', name: 'Grid Electrification', branch: 'Civilian Industry', tier: 2, cost: 18, requires: ['assembly'], effect: '+0.4% annual productivity growth', apply: (m) => { m.growth += 0.004; } },
  { id: 'automation', name: 'Industrial Automation', branch: 'Civilian Industry', tier: 3, cost: 40, requires: ['electrify'], effect: '+15% factory capacity', apply: (m) => { m.industry += 0.15; } },
  // Military production
  { id: 'stdarms', name: 'Standardised Small Arms', branch: 'Military Production', tier: 1, cost: 6, requires: [], effect: '−12% small-arms cost, +5% infantry quality', apply: (m) => { m.equipCost.smallArms *= 0.88; m.quality.smallArms += 0.05; } },
  { id: 'modart', name: 'Modern Artillery', branch: 'Military Production', tier: 2, cost: 16, requires: ['stdarms'], effect: '+12% artillery quality', apply: (m) => { m.quality.artillery += 0.12; } },
  { id: 'precision', name: 'Precision Munitions', branch: 'Military Production', tier: 3, cost: 36, requires: ['modart'], effect: '+12% artillery & aircraft quality', apply: (m) => { m.quality.artillery += 0.12; m.quality.aircraft += 0.12; } },
  // Logistics
  { id: 'motorsupply', name: 'Motorised Supply Columns', branch: 'Logistics', tier: 1, cost: 7, requires: [], effect: '+20% supply range', apply: (m) => { m.supplyRange += 0.2; } },
  { id: 'raillog', name: 'Rail Logistics', branch: 'Logistics', tier: 2, cost: 15, requires: ['motorsupply'], effect: '+20% supply throughput', apply: (m) => { m.supplyThroughput += 0.2; } },
  { id: 'fielddepot', name: 'Forward Field Depots', branch: 'Logistics', tier: 3, cost: 30, requires: ['raillog'], effect: '+25% supply range', apply: (m) => { m.supplyRange += 0.25; } },
  // Comms & recon
  { id: 'radio', name: 'Tactical Radio Nets', branch: 'Communications & Recon', tier: 1, cost: 8, requires: [], effect: '+8% organisation', apply: (m) => { m.organisation += 0.08; } },
  { id: 'drones', name: 'Reconnaissance Drones', branch: 'Communications & Recon', tier: 2, cost: 18, requires: ['radio'], effect: '+30% recon, better intel estimates', apply: (m) => { m.recon += 0.3; } },
  { id: 'sigint', name: 'Signals Intelligence', branch: 'Communications & Recon', tier: 3, cost: 34, requires: ['drones'], effect: '+30% recon, +10% organisation', apply: (m) => { m.recon += 0.3; m.organisation += 0.1; } },
  // Armor & vehicles
  { id: 'apc', name: 'Armoured Personnel Carriers', branch: 'Armor & Vehicles', tier: 1, cost: 9, requires: [], effect: '+10% vehicle quality, −8% vehicle cost', apply: (m) => { m.quality.vehicles += 0.1; m.equipCost.vehicles *= 0.92; } },
  { id: 'mbt2', name: 'Second-Generation Tanks', branch: 'Armor & Vehicles', tier: 2, cost: 22, requires: ['apc'], effect: '+15% armor quality', apply: (m) => { m.quality.armor += 0.15; } },
  { id: 'composite', name: 'Composite Armor', branch: 'Armor & Vehicles', tier: 3, cost: 42, requires: ['mbt2'], effect: '+15% armor quality, −10% armor cost', apply: (m) => { m.quality.armor += 0.15; m.equipCost.armor *= 0.9; } },
  // Aviation & naval
  { id: 'jets', name: 'Jet Fighters', branch: 'Aviation & Naval', tier: 1, cost: 12, requires: [], effect: '+15% aircraft quality', apply: (m) => { m.quality.aircraft += 0.15; } },
  { id: 'amphib', name: 'Amphibious Doctrine', branch: 'Aviation & Naval', tier: 2, cost: 16, requires: ['jets'], effect: 'Halves landing penalty, −30% transport cost', apply: (m) => { m.amphibious += 0.5; } },
  { id: 'missiles', name: 'Anti-Ship Missiles', branch: 'Aviation & Naval', tier: 3, cost: 34, requires: ['amphib'], effect: '+20% naval quality', apply: (m) => { m.quality.ships += 0.2; } },
  // Medicine
  { id: 'fieldhosp', name: 'Field Hospitals', branch: 'Medicine', tier: 1, cost: 7, requires: [], effect: '+15% of wounded return to service', apply: (m) => { m.casualtyRecovery += 0.15; } },
  { id: 'trauma', name: 'Trauma Medicine', branch: 'Medicine', tier: 2, cost: 16, requires: ['fieldhosp'], effect: '+15% wounded recovery', apply: (m) => { m.casualtyRecovery += 0.15; } },
  { id: 'medevac', name: 'Air Medical Evacuation', branch: 'Medicine', tier: 3, cost: 28, requires: ['trauma'], effect: '+10% wounded recovery, +5% organisation', apply: (m) => { m.casualtyRecovery += 0.1; m.organisation += 0.05; } },
  // Administration
  { id: 'census', name: 'National Census Bureau', branch: 'Administration', tier: 1, cost: 6, requires: [], effect: '+4% tax efficiency', apply: (m) => { m.taxEff += 0.04; } },
  { id: 'bureaucracy', name: 'Professional Civil Service', branch: 'Administration', tier: 2, cost: 15, requires: ['census'], effect: '−20% administration cost', apply: (m) => { m.adminCost *= 0.8; } },
  { id: 'integration', name: 'Regional Integration Policy', branch: 'Administration', tier: 3, cost: 26, requires: ['bureaucracy'], effect: '+50% integration speed', apply: (m) => { m.integrationSpeed += 0.5; } },
  { id: 'labs', name: 'National Science Foundation', branch: 'Administration', tier: 2, cost: 12, requires: ['census'], effect: '+15% research speed', apply: (m) => { m.researchSpeed += 0.15; } },
];
export const TECH_BY_ID = Object.fromEntries(TECHS.map((t) => [t.id, t]));

export function baseTechMods(): TechMods {
  return {
    industry: 1, taxEff: 1, adminCost: 1, supplyRange: 1, supplyThroughput: 1, organisation: 1, recon: 1, casualtyRecovery: 0.35,
    integrationSpeed: 1, amphibious: 0, researchSpeed: 1, growth: 0,
    quality: { smallArms: 1, artillery: 1, vehicles: 1, armor: 1, aircraft: 1, ships: 1 },
    equipCost: { smallArms: 1, artillery: 1, vehicles: 1, armor: 1, aircraft: 1, ships: 1 },
  };
}
export function recomputeTechMods(n: Nation) {
  const m = baseTechMods();
  for (const id of n.research.done) TECH_BY_ID[id]?.apply(m);
  n.techMods = m;
}
export function canResearch(n: Nation, id: string) {
  const t = TECH_BY_ID[id];
  return !!t && !n.research.done.includes(id) && t.requires.every((r) => n.research.done.includes(r));
}

/** Research points per year from funding and labs. */
export function researchRate(s: GameState, n: Nation): number {
  let labs = 0;
  for (const p of ownedBy(s, n.id)) labs += s.provinces[p].buildings.lab;
  const eff = (1 + labs * ECON.LAB_BONUS) * n.techMods.researchSpeed;
  return (ECON.RP_PER_MIC * Math.pow(Math.max(0, n.researchFunding / n.priceIndex), 0.6) + labs * ECON.LAB_RP) * eff;
}

export function researchDaily(s: GameState, n: Nation) {
  if (!n.research.current) {
    const nextId = n.research.queue.find((id) => canResearch(n, id));
    if (nextId) { n.research.current = nextId; n.research.queue = n.research.queue.filter((q) => q !== nextId); }
    else return;
  }
  const t = TECH_BY_ID[n.research.current];
  if (!t || !canResearch(n, t.id)) { n.research.current = null; return; }
  n.research.progress += (researchRate(s, n) * govMods(s, n).research) / 365;
  if (n.research.progress >= t.cost) {
    n.research.done.push(t.id);
    n.research.progress = 0;
    n.research.current = null;
    recomputeTechMods(n);
    if (n.isPlayer) addEvent(s, 'research', `Research complete: ${t.name} (${t.effect}).`, [n.id], { important: true });
  }
}

registerTechCost((n) => (n.research.current ? TECH_BY_ID[n.research.current]?.cost ?? 20 : 20));
