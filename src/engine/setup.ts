import type { GameSettings, GameState, Nation, Personality, ProvinceState, UnitType, Buildings } from './types';
import { ECON, SAVE_VERSION, RESOURCE, START_NUKES } from './config';
import { WORLD, PROV, COUNTRY_GEO } from './geo';
import { mulberry } from './rng';
import { baseTechMods, recomputeTechMods } from './research';
import { infraOf, aggregate, computeBudget, provinceOutput } from './economy';
import { createArmy, newUnit, makeGeneral, assignGeneral, unitUpkeep } from './military';
import { invalidateTerritory, invalidateArmies, invalidateDiplo, rel } from './world';
import { resetSupplyCache } from './supply';
import { newGov } from './policy';

export interface Campaign {
  id: string; title: string; nation: string; difficulty: 'tutorial' | 'standard' | 'hard'; role: string; blurb: string;
  strengths: string[]; weaknesses: string[];
}
export const CAMPAIGNS: Campaign[] = [
  { id: 'tutorial', title: 'Tutorial: The Belgrade Accord', nation: 'SRB', difficulty: 'tutorial', role: 'Small, vulnerable nation', blurb: 'A guided first campaign. Learn to balance the budget, raise an army, manage supply, win a battle and negotiate peace in the fractured Balkans.', strengths: ['Guided objectives', 'Forgiving AI'], weaknesses: ['Tiny economy', 'Landlocked'] },
  { id: 'serbia', title: 'Rise from the Balkans', nation: 'SRB', difficulty: 'standard', role: 'Small, vulnerable nation', blurb: 'Treasury 100 M IC, tax revenue 35 M IC. Surrounded by rivals large and small. Every brigade counts.', strengths: ['Cheap upkeep', 'Hills & rivers to defend'], weaknesses: ['Small manpower', 'No coastline', 'Weak industry'] },
  { id: 'poland', title: 'The Vistula Ascendant', nation: 'POL', difficulty: 'standard', role: 'Medium regional power', blurb: 'A solid regional power on the open plains between two giants. Strong enough to expand, exposed enough to fear.', strengths: ['Balanced economy', 'Good manpower'], weaknesses: ['Flat, hard to defend', 'Powerful neighbours'] },
  { id: 'germany', title: 'Industrial Hegemon', nation: 'DEU', difficulty: 'standard', role: 'Wealthy industrial nation', blurb: 'The richest economy in Europe and a small, professional army. Convert factories into power before your neighbours unite.', strengths: ['Huge industry', 'Rich treasury', 'Advanced tech'], weaknesses: ['Small standing army', 'Many neighbours'] },
  { id: 'turkey', title: 'Legions of Anatolia', nation: 'TUR', difficulty: 'standard', role: 'Large army, costly upkeep', blurb: 'A huge conscript army that devours the budget. Use it before the deficit does what no enemy could.', strengths: ['Massive army', 'Mountain defences', 'Straits'], weaknesses: ['Budget deficit', 'High upkeep', 'Unstable region'] },
  { id: 'japan', title: 'Island Fortress', nation: 'JPN', difficulty: 'standard', role: 'Isolated, defensible nation', blurb: 'Safe behind the sea, rich and technologically advanced — but every conquest needs ships and transports.', strengths: ['Sea moat', 'High technology', 'Wealth'], weaknesses: ['Few resources', 'Naval logistics required'] },
  { id: 'sandbox', title: 'Sandbox: Any Nation', nation: 'SRB', difficulty: 'standard', role: 'Choose any of the world\'s nations', blurb: 'Pick any country on the map and shape its destiny. Difficulty depends on the nation you choose: small, poor or encircled states are the hardest starts.', strengths: ['Total freedom'], weaknesses: ['No scripted help'] },
  { id: 'hard', title: 'Hard: Last Stand of Armenia', nation: 'ARM', difficulty: 'hard', role: 'Survival against stronger opponents', blurb: 'A tiny mountain republic between hostile powers, starting at war. Survive, then thrive.', strengths: ['Mountains', 'Motivated army'], weaknesses: ['Starts at war', 'Tiny economy', 'Landlocked'] },
];

const PALETTE = ['#8c3b3b', '#3b5f8c', '#4f7a3a', '#8c7a3b', '#6b3b8c', '#3b8c80', '#8c5a3b', '#56607a', '#7a3b5f', '#5f7a3b', '#3b6f8c', '#9a6a3a', '#5a3b8c', '#3b8c5a', '#8c3b6b', '#7a7040', '#456e6e', '#8a4f2f', '#4b5c99', '#6e8a46', '#99475c', '#3f7f6a', '#7b5ea8', '#a0703c'];
const FIXED_COLORS: Record<string, string> = {
  SRB: '#b0413e', POL: '#d4d4d8', DEU: '#5a5f66', TUR: '#b8553a', JPN: '#e8e2d0', USA: '#3b5f9c', RUS: '#3f6b4a', CHN: '#c9a227', GBR: '#c0392b', FRA: '#3f63b5', IND: '#e08a3c', BRA: '#4c9a4a', ARM: '#d07a2e', ITA: '#3f8f5a', ESP: '#d4b23a', CAN: '#a33a3a', AUS: '#3a7fa0', IRN: '#5c8f3f', SAU: '#2f7a4c', EGY: '#c4a66a', MEX: '#6a8f3a', ARG: '#7fb0d8', UKR: '#4a7ab0', KAZ: '#5aa0a0', IDN: '#a8463c', NGA: '#3c8a5a', ZAF: '#c48a3c', PAK: '#2e6e3e', KOR: '#5070a8', PRK: '#7a2f2f', SWE: '#3a6ea8', NOR: '#8a3c3c', FIN: '#e0e0e8', HUN: '#5a8a5a', ROU: '#c8b040', BGR: '#4a8a6a', GRC: '#5a8ad0', HRV: '#7a5aa0', BIH: '#c0a050', ALB: '#a04040', MKD: '#d08050', MNE: '#7a3a5a', KOS: '#5a7ab0', AZE: '#3a8ab0', GEO: '#c05a5a',
};

function hexToRgb(h: string) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }

const PERSONALITY_OVERRIDE: Record<string, Personality> = {
  RUS: 'expansionist', CHN: 'industrial', USA: 'diplomatic', DEU: 'industrial', FRA: 'diplomatic', GBR: 'diplomatic', TUR: 'expansionist', IRN: 'opportunistic', JPN: 'isolationist', CHE: 'isolationist', IND: 'defensive', PAK: 'opportunistic', SAU: 'defensive', EGY: 'opportunistic', BRA: 'industrial', ISR: 'defensive', PRK: 'expansionist', KOR: 'industrial', HUN: 'opportunistic', AZE: 'expansionist', ARM: 'defensive',
};
/** Military spending as share of output per scenario nation (others derive from personality). */
const MIL_SHARE: Record<string, number> = { SRB: 0.0714, POL: 0.07, DEU: 0.045, TUR: 0.16, JPN: 0.045, RUS: 0.11, USA: 0.07, CHN: 0.06, ARM: 0.12, AZE: 0.1, IRN: 0.09, PRK: 0.2, ISR: 0.1, IND: 0.06 };

export function newGame(campaignId: string, opts: Partial<GameSettings> & { seed?: number; nation?: string; players?: string[] } = {}): GameState {
  const camp0 = CAMPAIGNS.find((c) => c.id === campaignId) ?? CAMPAIGNS[1];
  // any nation may be played: the campaign's default nation is only a suggestion
  const camp = opts.nation && COUNTRY_GEO[opts.nation] ? { ...camp0, nation: opts.nation } : camp0;
  const seed = (opts.seed ?? Math.floor(Math.random() * 2 ** 31)) >>> 0;
  let rs = seed;
  const rnd = () => { const [v, n] = mulberry(rs); rs = n; return v; };
  const settings: GameSettings = {
    difficulty: camp.difficulty, startYear: 2040, alternateHistory: 'fractured', aiAggression: camp.difficulty === 'tutorial' ? 0.55 : camp.difficulty === 'hard' ? 1.25 : 1,
    victory: { kind: 'domination', provinceShare: 0.35 }, ...opts,
    nation: undefined, players: undefined,
  } as GameSettings;
  if (camp.id === 'hard' && !opts.victory) settings.victory = { kind: 'survival', years: 10 };
  if (camp.id === 'tutorial' && !opts.victory) settings.victory = { kind: 'hegemony', region: 'Southern Europe', regionShare: 0.5 };

  const s: GameState = {
    version: SAVE_VERSION, seed, rng: seed ^ 0x9e3779b9, day: 0, startYear: settings.startYear, player: camp.nation, players: [camp.nation, ...(opts.players ?? []).filter((x) => x !== camp.nation && COUNTRY_GEO[x])], eventSeq: 0,
    nations: {}, provinces: [], armies: {}, fleets: {}, generals: {}, battles: {}, activeBattles: [], wars: [], relations: {},
    events: [], peaceOffers: [], proposals: [],
    market: { food: { price: RESOURCE.food.basePrice, supply: 0, demand: 0 }, steel: { price: RESOURCE.steel.basePrice, supply: 0, demand: 0 }, oil: { price: RESOURCE.oil.basePrice, supply: 0, demand: 0 }, rare: { price: RESOURCE.rare.basePrice, supply: 0, demand: 0 } },
    nextId: 1, settings, achievements: {}, timeline: [], tutorial: camp.id === 'tutorial' ? { step: 0, done: false, flags: {}, startProvinces: 2 } : null, outcome: null, campaign: camp.id, notifications: [],
    stats: { battles: 0, wars: 0, peaceDeals: 0, annexations: 0 },
    strikes: [],
  };

  // ---- nations
  const personalities: Personality[] = ['defensive', 'expansionist', 'industrial', 'diplomatic', 'opportunistic', 'isolationist', 'defensive', 'industrial', 'diplomatic'];
  WORLD.countries.forEach((c, i) => {
    const output = ECON.OUTPUT_K * Math.pow(Math.max(500, c.gdp), ECON.OUTPUT_EXP) * (1 + 0.04 * Math.log10(c.pop / 1e6 + 1));
    let pers = PERSONALITY_OVERRIDE[c.id] ?? personalities[Math.floor(rnd() * personalities.length)];
    if (settings.alternateHistory === 'fractured' && rnd() < 0.15 && !PERSONALITY_OVERRIDE[c.id]) pers = 'expansionist';
    const n: Nation = {
      id: c.id, name: c.name, color: FIXED_COLORS[c.id] ?? PALETTE[(i * 7 + c.mapcolor * 3) % PALETTE.length],
      isPlayer: c.id === camp.nation || (opts.players ?? []).includes(c.id), alive: true, personality: pers, capital: c.capital,
      treasury: output * ECON.START_TREASURY_RATIO, debt: 0, interestRate: ECON.BASE_INTEREST, taxRate: ECON.BASE_TAX,
      researchFunding: 0, stability: 70, warSupport: 50, warExhaustion: 0, infamy: 0, manpower: 0, mobilization: 0, mobilize: false, priceIndex: 1,
      stockpile: { smallArms: 0, artillery: 0, vehicles: 0, armor: 0, aircraft: 0, ships: 0 }, production: [], training: [], shipyard: [], construction: [],
      research: { current: null, progress: 0, done: [], queue: [] }, techMods: baseTechMods(),
      budget: { income: [], expenses: [], totalIncome: 0, totalExpense: 0, net: 0, output },
      ledgerMonth: { income: 0, expense: 0 }, history: [], overlord: null, bankrupt: false, lastFactories: 0,
      shortages: { food: 0, steel: 0, oil: 0, rare: 0 }, resourceNet: { food: 0, steel: 0, oil: 0, rare: 0 }, reparations: [], claims: {},
      intel: c.income.startsWith('1') ? 0.7 : c.income.startsWith('2') ? 0.6 : 0.45,
      lastWarDay: -9999, aiMemory: {}, arsenal: { drone: 0, missile: 0, nuke: START_NUKES[c.id] ?? 0 }, nukeProgram: START_NUKES[c.id] ? 0 : -1, warheads: [], embargoUntil: 0, gov: newGov(),
      stats: { battlesWon: 0, battlesLost: 0, casualtiesInflicted: 0, casualtiesSuffered: 0, provincesCaptured: 0, peakProvinces: c.provinces.length, peakOutput: output },
    };
    // high-income nations start with some technology
    const techs = c.income.startsWith('1') ? ['assembly', 'stdarms', 'radio', 'census', 'motorsupply', 'apc', 'fieldhosp', 'jets'] : c.income.startsWith('2') ? ['stdarms', 'census', 'assembly'] : c.income.startsWith('3') ? ['stdarms'] : [];
    n.research.done = [...techs];
    recomputeTechMods(n);
    s.nations[n.id] = n;
    // output distributed over provinces by population with urban weighting
    const ws = c.provinces.map((p) => PROV[p].pop * (1 + Math.min(1.5, PROV[p].cityPop / Math.max(1, PROV[p].pop)) * 0.6) + 1);
    const wt = ws.reduce((a, b) => a + b, 0);
    c.provinces.forEach((pid, k) => {
      const g = PROV[pid];
      const share = ws[k] / wt;
      const pOut = output * share;
      const b: Buildings = { factory: 0, farm: 0, mine: 0, port: 0, railway: 0, road: 0, power: 0, lab: 0, fort: 0, depot: 0 };
      const rich = c.income.startsWith('1') ? 2 : c.income.startsWith('2') ? 1.3 : c.income.startsWith('3') ? 0.8 : 0.4;
      b.road = Math.min(4, Math.round(rich * 1.2 + (g.cityPop > 1e6 ? 1 : 0)));
      b.railway = Math.min(3, Math.round(rich * 0.7 + (g.cityPop > 3e6 ? 1 : 0) - 0.4));
      if (g.seas.length && (g.cityPop > 2e5 || rnd() < 0.4)) b.port = Math.max(1, Math.min(4, Math.round(rich + (g.cityPop > 2e6 ? 1 : 0))));
      b.factory = Math.min(12, Math.round(pOut / 55));
      b.power = Math.min(3, Math.round(pOut / 180));
      b.lab = rich >= 2 ? Math.min(3, Math.round(pOut / 300)) : 0;
      if (g.capital) b.depot = 1;
      if (g.terrain === 'mountains' || g.terrain === 'hills') b.fort = rnd() < 0.3 ? 1 : 0;
      // flat building output is part of the calibrated total: subtract it from population-based output
      const st: ProvinceState = { id: pid, owner: c.id, controller: c.id, status: 'core', formerOwner: c.id, pop: g.pop, dev: 0, dev0: 0, infra: 1, buildings: b, damage: 0, resistance: 0, integration: 1 };
      st.infra = infraOf(st);
      const flat = provinceOutput(s, { ...st, dev: 0 });
      const remaining = Math.max(pOut * 0.25, pOut - flat);
      st.dev = remaining / Math.max(0.01, g.pop / 1e6) / (1 + 0.12 * b.power);
      st.dev0 = st.dev;
      s.provinces[pid] = st;
    });
  });

  // ---- calibrate the player's starting position for the small-nation scenario
  invalidateTerritory();
  invalidateArmies();
  resetSupplyCache();

  // ---- militaries
  for (const n of Object.values(s.nations)) {
    const c = COUNTRY_GEO[n.id];
    const out = n.budget.output;
    const pers = n.personality;
    const share = MIL_SHARE[n.id] ?? ({ defensive: 0.05, expansionist: 0.075, industrial: 0.035, diplomatic: 0.035, opportunistic: 0.055, isolationist: 0.045 }[pers]);
    const milBudget = out * share;
    const rich = c.income.startsWith('1');
    const mix: [UnitType, number][] = rich
      ? [['infantry', 0.35], ['mechanized', 0.2], ['armored', 0.12], ['artillery', 0.14], ['recon', 0.07], ['engineers', 0.05], ['air', 0.07]]
      : c.income.startsWith('2') || c.income.startsWith('3')
        ? [['infantry', 0.55], ['mechanized', 0.08], ['armored', 0.06], ['artillery', 0.16], ['recon', 0.08], ['engineers', 0.04], ['air', 0.03]]
        : [['infantry', 0.75], ['artillery', 0.15], ['recon', 0.1]];
    const units: UnitType[] = [];
    let spent = 0;
    // deterministic fill toward budget following mix proportions
    const counts: Record<string, number> = {};
    for (let guard = 0; guard < 600; guard++) {
      let pick: UnitType = 'infantry', bestGap = -Infinity;
      for (const [t, w] of mix) {
        const gap = w - (counts[t] ?? 0) / Math.max(1, units.length);
        if (gap > bestGap) { bestGap = gap; pick = t; }
      }
      const cost = unitUpkeep(pick, n);
      if (spent + cost > milBudget * 1.02) {
        if (pick !== 'infantry' && spent + unitUpkeep('infantry', n) <= milBudget * 1.02) pick = 'infantry';
        else break;
      }
      units.push(pick); counts[pick] = (counts[pick] ?? 0) + 1; spent += unitUpkeep(pick, n);
    }
    if (!units.length) units.push('infantry');
    // group into armies: ~8-12 formations each, stationed at capital and border provinces
    const provs = c.provinces.slice().sort((a, b) => PROV[b].cityPop - PROV[a].cityPop);
    const per = Math.max(4, Math.min(14, Math.ceil(units.length / Math.max(1, Math.min(provs.length, Math.ceil(units.length / 9))))));
    let k = 0, ai = 0;
    while (k < units.length) {
      const group = units.slice(k, k + per);
      k += per;
      const loc = ai === 0 ? n.capital : provs[ai % provs.length];
      const a = createArmy(s, n.id, loc, group.map((t) => { const u = newUnit(s, t, 1, 0.15 + rnd() * 0.15); u.org = 0.55; return u; }));
      a.entrench = 0.5;
      ai++;
    }
    // manpower pool
    n.manpower = c.pop * ECON.MANPOWER_SHARE * 0.6;
    // generals: 1-4 hired + 3 in pool
    const hired = Math.min(4, Math.max(1, Math.round(Math.log10(out + 1))));
    const armies = Object.values(s.armies).filter((a) => a.owner === n.id);
    for (let g = 0; g < hired; g++) {
      const gen = makeGeneral(s, n.id, rich ? 0.6 : 0.4, rnd, false);
      if (armies[g]) assignGeneral(s, gen.id, armies[g].id);
    }
    if (n.isPlayer) for (let g = 0; g < 4; g++) makeGeneral(s, n.id, 0.3 + rnd() * 0.6, rnd, true);
    // research funding ~0.8% of output
    n.researchFunding = Math.round(out * 0.008 * 10) / 10;
    // navies for coastal nations
    const ports = c.provinces.filter((p) => s.provinces[p].buildings.port > 0);
    if (ports.length && out > 300) {
      const home = ports.sort((a, b) => PROV[b].cityPop - PROV[a].cityPop)[0];
      const scale = Math.log10(out);
      const f = { id: s.nextId++, owner: n.id, name: `${n.name} Home Fleet`, sea: PROV[home].seas[0], ships: { destroyer: Math.round(scale * 1.5), cruiser: Math.max(0, Math.round(scale - 2)), battlegroup: out > 4000 ? Math.round((out / 4000) ** 0.5) : 0, transport: Math.round(scale) }, path: [], moveProgress: 0, org: 0.8, homePort: home, mission: 'patrol' as const };
      s.fleets[f.id] = f;
    }
  }

  // ---- scenario-specific setup
  scenarioTweaks(s, camp.id, rnd);
  // initial diplomacy: some regional alliances & trade for a living world
  initialDiplomacy(s, rnd);
  // budgets
  invalidateDiplo();
  refreshAllBudgets(s);
  // calibrate player starting finances for small-nation campaigns
  const p = s.nations[s.player];
  if (camp.nation === 'SRB') { p.treasury = 100; }
  if (opts.customTreasury) p.treasury = opts.customTreasury;
  p.researchFunding = Math.max(1, p.researchFunding);
  if (camp.nation === 'SRB') p.researchFunding = 1;
  refreshAllBudgets(s);
  return s;
}

function scenarioTweaks(s: GameState, id: string, rnd: () => number) {
  const p = s.nations[s.player];
  if (id === 'turkey') { p.treasury *= 0.5; p.stability = 60; }
  if (id === 'germany') { p.treasury *= 1.4; }
  if (id === 'japan') { p.personality = 'isolationist'; }
  if (id === 'tutorial') {
    // a forgiving neighbourhood: neighbours less aggressive
    for (const n of Object.values(s.nations)) if (!n.isPlayer && COUNTRY_GEO[n.id].subregion === 'Southern Europe') n.personality = n.personality === 'expansionist' ? 'defensive' : n.personality;
  }
  if (id === 'hard') {
    const aze = s.nations['AZE'];
    if (aze) {
      aze.personality = 'expansionist';
      // AZE starts at war with the player
      s.wars.push({ id: s.nextId++, attackers: ['AZE'], defenders: [s.player], leaderA: 'AZE', leaderD: s.player, startDay: 0, name: 'Caucasus War', justified: true, scoreA: 0, casualtiesA: 0, casualtiesD: 0, battles: 0, occupiedByA: [], occupiedByD: [] });
      aze.mobilize = true;
      p.mobilize = true;
    }
  }
  void rnd;
}

function initialDiplomacy(s: GameState, rnd: () => number) {
  const ids = Object.keys(s.nations);
  const bySub = new Map<string, string[]>();
  for (const id of ids) { const sub = COUNTRY_GEO[id].subregion; (bySub.get(sub) || bySub.set(sub, []).get(sub)!).push(id); }
  // trade agreements within subregions, some alliances
  for (const [, group] of bySub) {
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
      const a = group[i], b = group[j];
      const r = rel(s, a, b);
      r.value = Math.round((rnd() - 0.4) * 50);
      if (rnd() < 0.3 && !s.nations[a].isPlayer && !s.nations[b].isPlayer) r.trade = true;
      if (rnd() < 0.05 && !s.nations[a].isPlayer && !s.nations[b].isPlayer) { r.alliance = true; r.value = Math.max(r.value, 45); }
    }
  }
  // a few famous blocs in this alternate history
  const blocs: string[][] = s.settings.alternateHistory === 'blocs'
    ? [['USA', 'GBR', 'CAN', 'AUS'], ['FRA', 'DEU', 'ITA', 'ESP', 'BEL', 'NLD'], ['RUS', 'BLR', 'KAZ'], ['CHN', 'PRK']]
    : s.settings.alternateHistory === 'balanced' ? [] : [['USA', 'CAN'], ['FRA', 'BEL'], ['RUS', 'BLR']];
  for (const b of blocs) for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) {
    if (!s.nations[b[i]] || !s.nations[b[j]] || s.nations[b[i]].isPlayer || s.nations[b[j]].isPlayer) continue;
    const r = rel(s, b[i], b[j]); r.alliance = true; r.trade = true; r.value = 60;
  }
}

export function refreshAllBudgets(s: GameState) {
  const armiesBy = new Map<string, number[]>();
  for (const a of Object.values(s.armies)) (armiesBy.get(a.owner) || armiesBy.set(a.owner, []).get(a.owner)!).push(a.id);
  const fleetsBy = new Map<string, number[]>();
  for (const f of Object.values(s.fleets)) (fleetsBy.get(f.owner) || fleetsBy.set(f.owner, []).get(f.owner)!).push(f.id);
  // two passes: trade revenue depends on partners' output
  for (let pass = 0; pass < 2; pass++) {
    for (const n of Object.values(s.nations)) {
      if (!n.alive) continue;
      const agg = aggregate(s, n, armiesBy, fleetsBy);
      n.budget = computeBudget(s, n, agg);
    }
  }
}

export { hexToRgb };
