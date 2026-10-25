/**
 * CENTRAL BALANCE CONFIGURATION
 *
 * Every price, rate and modifier in the game derives from the values in this file.
 * Currency: US dollars. All money values are in MILLIONS of dollars ($B).
 * These are fictional game-balance figures, not real-world procurement prices.
 */
import type { BuildingKind, EquipKind, Posture, ResourceKind, ShipType, Terrain, UnitType, Weather, Personality } from './types';

export const SAVE_VERSION = 8;
export const DAYS_PER_YEAR = 365;

// ---------------------------------------------------------------- economy
export const ECON = {
  /** National output ($B / yr) = OUTPUT_K * GDP^OUTPUT_EXP * popFactor. Calibrated so a 51 bn-GDP nation ≈ $140B. */
  OUTPUT_K: 0.0586,
  OUTPUT_EXP: 0.72,
  BASE_TAX: 0.25,
  MIN_TAX: 0.10,
  MAX_TAX: 0.50,
  /** Civilian services as a share of output (education, health, police...). */
  SERVICES_SHARE: 0.103,
  /** Administration = ADMIN_SHARE * output * (1 + provinces/25)^ADMIN_EXP — larger realms cost more to run. */
  ADMIN_SHARE: 0.012,
  ADMIN_EXP: 0.6,
  /** Per non-core province flat administration ($B / yr) plus share of its output. */
  OCCUPATION_FLAT: 0.6,
  OCCUPATION_SHARE: 0.08,
  AUTONOMY_SHARE: 0.02,
  /** Output multiplier for province by status. */
  STATUS_OUTPUT: { core: 1, integrating: 0.55, occupied: 0.35, autonomous: 0.7 } as Record<string, number>,
  /** Tax collected from province by status (autonomous regions pay tribute instead of full taxes). */
  STATUS_TAX: { core: 1, integrating: 0.6, occupied: 0.4, autonomous: 0.45 } as Record<string, number>,
  /** Real growth of productivity per year at neutral conditions. */
  BASE_GROWTH: 0.011,
  /** Growth penalty per point of tax above base (e.g. 0.35 tax → −0.10*0.08). */
  TAX_GROWTH_PENALTY: 0.08,
  POP_GROWTH: 0.006,
  /** Productivity ceiling relative to starting dev, raised by infrastructure — prevents infinite growth. */
  DEV_CAP_BASE: 1.3,
  DEV_CAP_PER_INFRA: 0.08,
  START_TREASURY_RATIO: 0.71,
  /** Loans */
  BASE_INTEREST: 0.035,
  MAX_DEBT_RATIO: 1.5, // of annual output
  EMERGENCY_PREMIUM: 0.04,
  LOAN_STEP: 25,
  /** Inflation (price index) rises when the deficit exceeds this share of output. */
  INFLATION_THRESHOLD: 0.03,
  INFLATION_RATE: 0.25,
  DEFLATION_RATE: 0.04,
  /** Trade agreements: share of the smaller partner's output added as trade revenue to each. */
  TRADE_SHARE: 0.012,
  TRADE_MAX_PARTNER: 0.02, // cap per agreement as share of own output
  WAR_TRADE_PENALTY: 0.5,
  BLOCKADE_PENALTY: 0.35,
  /** Equipment capacity per factory ($B of equipment per year) and baseline civilian industry share. */
  FACTORY_CAPACITY: 3.2,
  BASE_INDUSTRY_SHARE: 0.035,
  /** Research: research points per $B funded, base pts from labs. */
  RP_PER_MIC: 5.0, // RP/yr = RP_PER_MIC * funding^0.6
  LAB_RP: 4,
  LAB_BONUS: 0.08,
  MANPOWER_SHARE: 0.016, // of population available for recruitment at peace
  MOBILIZED_MANPOWER_SHARE: 0.035,
  MANPOWER_REGEN: 0.0012, // per year of pop
  MOBILIZATION_DAYS: 30,
  MOBILIZED_UPKEEP: 1.2,
  MOBILIZED_OUTPUT: 0.97,
};

export const RESOURCE: Record<ResourceKind, { label: string; basePrice: number; perLevel: number }> = {
  // basePrice: $B per unit. perLevel: units/yr per resource level, scaled by sqrt(province area / 100,000 km²).
  food: { label: 'Food', basePrice: 1.0, perLevel: 2.0 },
  steel: { label: 'Steel', basePrice: 1.6, perLevel: 1.6 },
  oil: { label: 'Oil', basePrice: 2.2, perLevel: 2.0 },
  rare: { label: 'Rare metals', basePrice: 4.0, perLevel: 0.8 },
};
/** Demand per unit of the driver per year. */
export const RESOURCE_DEMAND = {
  foodPerMillionPop: 0.32,
  steelPerFactory: 0.25,
  oilPerFuel: 0.22,       // per unit fuel rating of deployed formations (doubled on campaign)
  oilPerOutput: 0.0012,   // civilian demand per $B output
};

// ---------------------------------------------------------------- buildings
export interface BuildingSpec {
  label: string; cost: number; days: number; upkeep: number; max: number;
  output: number;  // flat output $B / yr added to province
  desc: string; needsCoast?: boolean; steel?: number;
}
export const BUILDINGS: Record<BuildingKind, BuildingSpec> = {
  factory: { label: 'Factory', cost: 14, days: 240, upkeep: 0.35, max: 12, output: 3, steel: 2, desc: '+$3B output. Each factory also makes new formations 2.5% cheaper and 3% faster to train (up to 35% / 40%). Consumes steel.' },
  farm: { label: 'Agricultural Estate', cost: 5, days: 120, upkeep: 0.1, max: 6, output: 1.6, desc: '+1 food level, +$1.6B output. Food surplus raises stability.' },
  mine: { label: 'Extraction Site', cost: 9, days: 200, upkeep: 0.25, max: 4, output: 1.2, desc: '+50% of province steel/oil/rare yield per level (needs a resource).' },
  port: { label: 'Port', cost: 10, days: 210, upkeep: 0.3, max: 5, output: 1.5, needsCoast: true, desc: 'Sea supply hub, naval base, +trade. Required for naval transport.' },
  railway: { label: 'Railway', cost: 12, days: 240, upkeep: 0.3, max: 3, output: 1.0, steel: 1.5, desc: '+2 infrastructure, +60% supply throughput along the line.' },
  road: { label: 'Highway Network', cost: 4, days: 90, upkeep: 0.08, max: 4, output: 0.6, desc: '+1 infrastructure: faster movement and better supply.' },
  power: { label: 'Power Plant', cost: 11, days: 220, upkeep: 0.3, max: 3, output: 1.0, desc: '+12% province output and +15% factory capacity in province.' },
  lab: { label: 'Research Institute', cost: 10, days: 200, upkeep: 0.5, max: 3, output: 0.3, desc: `+${4} research points/yr and +8% research efficiency.` },
  fort: { label: 'Fortifications', cost: 6, days: 150, upkeep: 0.15, max: 5, output: 0, desc: '+12% defence per level for defenders in this province.' },
  depot: { label: 'Supply Depot', cost: 5, days: 90, upkeep: 0.2, max: 1, output: 0, desc: 'Regional supply hub; extends supply into the front.' },
};
export const REPAIR_COST_PER_DAMAGE = 30; // $B to repair 100% damage scaled by province output share
export const DEVELOP = { cost: 8, days: 180, boost: 0.04 };
export const INTEGRATE = { costPerOutput: 0.6, minCost: 3, days: 270 };

// ---------------------------------------------------------------- military
export const MIL = {
  SOLDIER_WAGE: 0.00028,   // $B per soldier per year
  RECRUIT_PER_SOLDIER: 0.00032, // induction and training per soldier
  EQUIP_MAINT: 0.07,       // share of equipment value per year
  SUPPLY_PRICE: 0.0011,    // $B per supply unit (food, ammo, spares)
  FUEL_PRICE_PER_OIL: 0.0012, // $B per fuel unit at oil base price
  PEACE_SUPPLY_FACTOR: 0.45, // garrison consumption share at peace (paid in upkeep)
  TRANSPORT_COST_PER_ZONE: 0.1, // $B per brigade per sea zone
  OPS_COST_SHARE: 0.65,  // share of full campaign fuel/ammunition cost charged while moving or fighting
  TRANSPORT_DAYS_PER_ZONE: 3,
  INVASION_WAIT: 10,       // days an invasion group in port waits past its sailing day for late armies
  ARMY_SUPPLY_DAYS: 25,    // carried supply stock in days of demand
  MAX_ARMY_UNITS: 24,
  ATTRITION_NO_SUPPLY: 0.004, // strength lost per day at zero supply
  /** Factories make the military cheaper and faster to raise: per factory, capped. */
  FACTORY_DISCOUNT: 0.025, FACTORY_DISCOUNT_MAX: 0.35, FACTORY_SPEED: 0.03, FACTORY_SPEED_MAX: 0.4,
  REINFORCE_RATE: 0.02,    // share of max strength refilled per day when supplied
  ORG_REGEN: 0.06,         // per day out of combat
  ENTRENCH_RATE: 0.04,
  STRAIT_DAYS: 2,
};

export interface UnitSpec {
  label: string; short: string; points: number; personnel: number; equip: Partial<Record<EquipKind, number>>; trainDays: number;
  speed: number; soft: number; hard: number; defense: number; breakthrough: number; hardness: number; piercing: number;
  recon: number; air: number; supply: number; fuel: number; width: number; support: boolean; desc: string;
}
export const UNITS: Record<UnitType, UnitSpec> = {
  infantry: { points: 10, label: 'Infantry Brigade', short: 'INF', personnel: 3000, equip: { smallArms: 1.2 }, trainDays: 60, speed: 26, soft: 6, hard: 1, defense: 9, breakthrough: 2, hardness: 0.05, piercing: 1, recon: 1, air: 0, supply: 1.0, fuel: 0, width: 2, support: false, desc: 'Backbone of any army. Cheap, sturdy on defence, slow.' },
  mechanized: { points: 18, label: 'Mechanized Brigade', short: 'MECH', personnel: 2500, equip: { smallArms: 0.8, vehicles: 3.2 }, trainDays: 90, speed: 44, soft: 8, hard: 3, defense: 11, breakthrough: 7, hardness: 0.45, piercing: 3, recon: 2, air: 0, supply: 1.4, fuel: 1.0, width: 2, support: false, desc: 'Infantry in armoured carriers. Fast, resilient, fuel-hungry.' },
  armored: { points: 30, label: 'Armored Brigade', short: 'ARM', personnel: 1800, equip: { armor: 7.0, vehicles: 1.0 }, trainDays: 120, speed: 40, soft: 10, hard: 12, defense: 5, breakthrough: 17, hardness: 0.85, piercing: 8, recon: 2, air: 0, supply: 1.9, fuel: 2.6, width: 2, support: false, desc: 'Main battle tanks. Breaks fronts, weak in jungle and mountains.' },
  artillery: { points: 12, label: 'Artillery Regiment', short: 'ART', personnel: 1500, equip: { artillery: 3.0, smallArms: 0.3 }, trainDays: 80, speed: 22, soft: 15, hard: 3, defense: 2, breakthrough: 1, hardness: 0.1, piercing: 2, recon: 0, air: 0, supply: 1.7, fuel: 0.3, width: 1, support: true, desc: 'Fire support from the second line. Consumes heavy ammunition.' },
  engineers: { points: 5, label: 'Engineer Battalion', short: 'ENG', personnel: 1200, equip: { vehicles: 0.8, smallArms: 0.4 }, trainDays: 70, speed: 26, soft: 1, hard: 1, defense: 3, breakthrough: 1, hardness: 0.2, piercing: 1, recon: 0, air: 0, supply: 0.6, fuel: 0.3, width: 0, support: true, desc: 'Bridging, fortification and obstacle clearing. Halves river/fort penalties, faster dig-in.' },
  recon: { points: 6, label: 'Reconnaissance Battalion', short: 'REC', personnel: 900, equip: { vehicles: 1.1, smallArms: 0.2 }, trainDays: 60, speed: 50, soft: 2, hard: 1, defense: 2, breakthrough: 2, hardness: 0.3, piercing: 1, recon: 6, air: 0, supply: 0.5, fuel: 0.5, width: 0, support: true, desc: 'Scouts and drones. Better intelligence, mobile-manoeuvre bonus.' },
  air: { points: 25, label: 'Fighter Squadron', short: 'FTR', personnel: 450, equip: { aircraft: 11.0 }, trainDays: 150, speed: 200, soft: 4, hard: 3, defense: 0, breakthrough: 0, hardness: 0, piercing: 6, recon: 3, air: 10, supply: 1.2, fuel: 2.2, width: 0, support: true, desc: 'Fighter jets. Win the skies over your battles, escort bombers, shoot down raids, drones and missiles. Range 1,300 km from their airbase.' },
  bomber: { points: 30, label: 'Bomber Squadron', short: 'BMB', personnel: 600, equip: { aircraft: 14.0 }, trainDays: 180, speed: 180, soft: 10, hard: 8, defense: 0, breakthrough: 0, hardness: 0, piercing: 8, recon: 1, air: 2, supply: 1.4, fuel: 3.0, width: 0, support: true, desc: 'Strike aircraft. Hit enemy troops in battle, bomb factories, power and railways, sink ships. Range 2,800 km; needs fighter cover against enemy jets.' },
};

export interface ShipSpec { label: string; points: number; personnel: number; cost: number; days: number; attack: number; defense: number; speed: number; capacity: number; }
export const SHIPS: Record<ShipType, ShipSpec> = {
  destroyer: { points: 8, label: 'Destroyer Flotilla', personnel: 1200, cost: 14, days: 180, attack: 4, defense: 4, speed: 1.4, capacity: 0 },
  cruiser: { points: 18, label: 'Cruiser Squadron', personnel: 2600, cost: 36, days: 300, attack: 10, defense: 9, speed: 1.1, capacity: 0 },
  battlegroup: { points: 60, label: 'Carrier Battle Group', personnel: 6000, cost: 110, days: 540, attack: 28, defense: 22, speed: 1.0, capacity: 0 },
  transport: { points: 1, label: 'Transport Flotilla', personnel: 700, cost: 7, days: 120, attack: 0, defense: 1, speed: 1.2, capacity: 4 },
};
export const SHIP_UPKEEP_SHARE = 0.06;

export const EQUIP_LABEL: Record<EquipKind, string> = {
  smallArms: 'Small arms', artillery: 'Artillery', vehicles: 'Vehicles', armor: 'Armor', aircraft: 'Aircraft', ships: 'Naval',
};
export const ADVANCED_EQUIP: EquipKind[] = ['armor', 'aircraft', 'ships'];

// ---------------------------------------------------------------- combat
export const TERRAIN: Record<Terrain, { label: string; move: number; width: number; attack: number; armor: number; defense: number; air: number; attrition: number; color: string }> = {
  plains:    { label: 'Plains',    move: 1.0,  width: 12, attack: 1.0,  armor: 1.0,  defense: 1.0,  air: 1.0, attrition: 0,     color: '#a7b56b' },
  forest:    { label: 'Forest',    move: 0.75, width: 9,  attack: 0.85, armor: 0.7,  defense: 1.15, air: 0.8, attrition: 0,     color: '#3f6b35' },
  jungle:    { label: 'Jungle',    move: 0.5,  width: 7,  attack: 0.7,  armor: 0.45, defense: 1.25, air: 0.6, attrition: 0.001, color: '#1f5a2c' },
  hills:     { label: 'Hills',     move: 0.8,  width: 9,  attack: 0.8,  armor: 0.75, defense: 1.2,  air: 0.95, attrition: 0,    color: '#9a8a55' },
  mountains: { label: 'Mountains', move: 0.5,  width: 6,  attack: 0.6,  armor: 0.4,  defense: 1.45, air: 0.8, attrition: 0.001, color: '#8a7f78' },
  desert:    { label: 'Desert',    move: 0.85, width: 12, attack: 0.95, armor: 1.05, defense: 0.95, air: 1.1, attrition: 0.0008, color: '#d6b873' },
  taiga:     { label: 'Taiga',     move: 0.7,  width: 9,  attack: 0.85, armor: 0.7,  defense: 1.15, air: 0.85, attrition: 0.0005, color: '#4d6b5a' },
  arctic:    { label: 'Arctic',    move: 0.55, width: 8,  attack: 0.75, armor: 0.6,  defense: 1.2,  air: 0.7, attrition: 0.002, color: '#dfe7ec' },
};
export const WEATHER: Record<Weather, { label: string; attack: number; move: number; air: number; supply: number; recon: number }> = {
  clear:   { label: 'Clear',   attack: 1.0,  move: 1.0,  air: 1.0, supply: 1.0, recon: 1.0 },
  rain:    { label: 'Rain',    attack: 0.92, move: 0.85, air: 0.7, supply: 1.05, recon: 0.85 },
  snow:    { label: 'Snow',    attack: 0.8,  move: 0.65, air: 0.5, supply: 1.3, recon: 0.75 },
  mud:     { label: 'Mud',     attack: 0.85, move: 0.55, air: 0.8, supply: 1.15, recon: 0.9 },
  monsoon: { label: 'Monsoon', attack: 0.82, move: 0.7,  air: 0.4, supply: 1.15, recon: 0.7 },
  heat:    { label: 'Heat',    attack: 0.92, move: 0.9,  air: 1.0, supply: 1.25, recon: 1.0 },
  fog:     { label: 'Fog',     attack: 0.95, move: 0.95, air: 0.4, supply: 1.0, recon: 0.5 },
  storm:   { label: 'Storm',   attack: 0.85, move: 0.75, air: 0.1, supply: 1.1, recon: 0.6 },
};
export interface PostureSpec { label: string; attack: number; defense: number; casualties: number; orgLoss: number; retreatAt: number; desc: string; }
export const POSTURES: Record<Posture, PostureSpec> = {
  aggressive: { label: 'Aggressive assault', attack: 1.25, defense: 0.95, casualties: 1.35, orgLoss: 1.2, retreatAt: 0.12, desc: 'Maximum pressure. Faster breakthroughs, heavy casualties and equipment losses.' },
  balanced:   { label: 'Balanced advance',   attack: 1.0,  defense: 1.0,  casualties: 1.0,  orgLoss: 1.0, retreatAt: 0.28, desc: 'Standard doctrine. No special bonuses or penalties.' },
  cautious:   { label: 'Cautious advance',   attack: 0.85, defense: 1.05, casualties: 0.7,  orgLoss: 0.9, retreatAt: 0.45, desc: 'Preserves the army, breaks off early. Gives the enemy time to dig in.' },
  defensive:  { label: 'Defensive preparation', attack: 0.7, defense: 1.25, casualties: 0.85, orgLoss: 0.85, retreatAt: 0.2, desc: 'Dig in and hold. Strong when attacked, weak when attacking. Entrenches twice as fast.' },
  mobile:     { label: 'Mobile manoeuvre',   attack: 1.0,  defense: 0.95, casualties: 0.9,  orgLoss: 1.0, retreatAt: 0.3, desc: 'Exploit speed and recon to flank. Big bonus with faster, better-scouted forces on open ground; poor in rough terrain.' },
  withdrawal: { label: 'Strategic withdrawal', attack: 0.5, defense: 0.8, casualties: 0.6, orgLoss: 1.0, retreatAt: 0.95, desc: 'Avoid decisive engagement. Trades ground for survival; rear-guard covers the retreat.' },
};
export const COMBAT = {
  DAMAGE_SCALE: 0.085,     // org damage per point of effective damage, per front-line formation
  STRENGTH_SCALE: 0.13,    // casualties per point of effective damage (fraction of formation /10)
  BREAKTHROUGH_DEF: 1.0,   // defence absorbs attacks up to this ratio
  EXCESS_HIT_MULT: 3.0,    // hits beyond defence are this much more damaging
  RANDOM_SPREAD: 0.12,     // ±12% daily variation
  MAX_DAYS: 24,
  WOUNDED_SHARE: 0.62,     // of casualties that are wounded (may recover)
  ENTRENCH_MAX_BONUS: 0.3,
  FORT_PER_LEVEL: 0.12,
  RIVER_PENALTY: 0.85,
  STRAIT_PENALTY: 0.7,
  AMPHIBIOUS_PENALTY: 0.6,  // landing from the sea (0.9 with full sea control)
  NAVAL_FIRE: 0.15,         // gunfire ashore per point of warship attack off the coast
  OUT_OF_SUPPLY_ATTACK: 0.45, // multiplier at 0 supply
  GENERAL_PER_SKILL: 0.05,
};

/**
 * How much the game favours human players, by difficulty: their armies fight better (attack and
 * defence ×combat), AI enemies accept their peace terms more readily (+peace war score), an AI
 * country losing to them surrenders what they hold once it keeps less than `surrender` of its land
 * (or has lost its capital and keeps under half), and only allies that border the fighting join
 * a war they start (farAllies: allies from anywhere join). Their armies always get at least
 * `supply` of what they need and recover organisation `recovery` times as fast.
 */
export const PLAYER_HELP: Record<'tutorial' | 'standard' | 'hard', { combat: number; peace: number; surrender: number; farAllies: boolean; supply: number; recovery: number }> = {
  tutorial: { combat: 1.8, peace: 35, surrender: 0.5, farAllies: false, supply: 0.6, recovery: 2.5 },
  standard: { combat: 1.5, peace: 20, surrender: 0.35, farAllies: false, supply: 0.5, recovery: 2 },
  hard: { combat: 1, peace: 0, surrender: 0, farAllies: true, supply: 0, recovery: 1 },
};

// ---------------------------------------------------------------- diplomacy
export const DIPLO = {
  WAR_STABILITY_UNJUSTIFIED: 12,
  WAR_STABILITY_JUSTIFIED: 4,
  WAR_INFAMY_UNJUSTIFIED: 18,
  WAR_INFAMY_JUSTIFIED: 7,
  NAP_BREAK_INFAMY: 15,
  INFAMY_DECAY: 6, // per year
  INFAMY_PER_PROVINCE: 2.5,
  RELATION_DECAY: 0.04, // toward baseline per week, scaled
  TRUCE_DAYS: 730,
  NAP_DAYS: 1825,
  REPARATION_YEARS: 5,
  ULTIMATUM_RELATION: -25,
  EXHAUSTION_PER_CASUALTY: 0.00012, // per soldier lost relative to manpower base
};

// ---------------------------------------------------------------- AI personalities
export const PERSONALITY: Record<Personality, { label: string; military: number; aggression: number; build: number; diplomacy: number; tax: number; desc: string }> = {
  defensive:     { label: 'Defensive',     military: 1.2,  aggression: 0.35, build: 1.0, diplomacy: 1.1, tax: 0.26, desc: 'Fortifies borders, joins defensive pacts.' },
  expansionist:  { label: 'Expansionist',  military: 1.45, aggression: 1.25, build: 0.8, diplomacy: 0.7, tax: 0.29, desc: 'Builds large armies and seeks weak neighbours.' },
  industrial:    { label: 'Industrial',    military: 0.85, aggression: 0.45, build: 1.5, diplomacy: 1.0, tax: 0.24, desc: 'Prioritises factories, infrastructure and trade.' },
  diplomatic:    { label: 'Diplomatic',    military: 0.9,  aggression: 0.35, build: 1.1, diplomacy: 1.6, tax: 0.25, desc: 'Seeks alliances, trade and negotiated settlements.' },
  opportunistic: { label: 'Opportunistic', military: 1.1,  aggression: 0.95, build: 1.0, diplomacy: 0.9, tax: 0.27, desc: 'Strikes when a rival is distracted or weakened.' },
  isolationist:  { label: 'Isolationist',  military: 1.0,  aggression: 0.2,  build: 1.15, diplomacy: 0.45, tax: 0.24, desc: 'Keeps to itself, defends strongly when attacked.' },
};

export const SPEEDS = [0, 1.5, 5, 16]; // game days per real second

export function weatherFor(lat: number, month: number, roll: number, terrain: Terrain): Weather {
  const north = lat >= 0;
  const m = north ? month : (month + 6) % 12; // seasons mirrored south of the equator
  const a = Math.abs(lat);
  if (a > 45 && (m === 11 || m <= 1)) return roll < 0.55 ? 'snow' : roll < 0.7 ? 'storm' : 'clear';
  if (a > 55 && (m === 10 || m === 2)) return roll < 0.45 ? 'snow' : 'mud';
  if (a > 42 && (m === 3 || m === 9 || m === 10)) return roll < 0.4 ? 'mud' : roll < 0.6 ? 'rain' : 'clear';
  if (lat > 5 && lat < 28 && month >= 5 && month <= 8 && terrain !== 'desert') return roll < 0.55 ? 'monsoon' : roll < 0.7 ? 'rain' : 'clear';
  if (terrain === 'desert' && m >= 5 && m <= 7) return roll < 0.6 ? 'heat' : 'clear';
  if (terrain === 'arctic') return roll < 0.5 ? 'snow' : roll < 0.65 ? 'storm' : 'clear';
  if (roll < 0.06) return 'fog';
  if (roll < 0.1) return 'storm';
  if (roll < 0.3) return 'rain';
  return 'clear';
}

// ---------------------------------------------------------------- precision strikes & strategic weapons
export interface StrikeSpec { label: string; plural: string; cost: number; range: number; kill: number; org: number; hitBuilding: number; damage: number; intercept: number; desc: string }
/** Conventional strikes: bought into a stockpile, fired at a province of a nation you are at war with. */
export const STRIKES: Record<'drone' | 'missile' | 'ballistic' | 'recon', StrikeSpec> = {
  ballistic: { label: 'Ballistic missile', plural: 'ballistic missiles', cost: 14, range: 4000, kill: 0.05, org: 0.12, hitBuilding: 2, damage: 0.1, intercept: 0.25,
    desc: 'Heavy, fast and hard to intercept (4,000 km). Each hit flattens two building levels and kills many troops.' },
  recon: { label: 'Recon drone', plural: 'recon drones', cost: 0.6, range: 900, kill: 0, org: 0, hitBuilding: 0, damage: 0, intercept: 0.8,
    desc: 'Unarmed. Reveals the exact enemy forces in a province for 30 days and gives your attacks there +6% (targeting data).' },
  drone: { label: 'Attack drone', plural: 'attack drones', cost: 1.2, range: 700, kill: 0.012, org: 0.05, hitBuilding: 0.3, damage: 0.02, intercept: 1,
    desc: 'Cheap loitering munitions. Short range (700 km from land you hold, or from a fleet offshore). Wear down troops and occasionally knock out a building.' },
  missile: { label: 'Cruise missile', plural: 'cruise missiles', cost: 5, range: 2500, kill: 0.025, org: 0.08, hitBuilding: 1, damage: 0.05, intercept: 0.5,
    desc: 'Long range (2,500 km, unlimited from a fleet offshore), harder to shoot down. Each hit destroys a building level — rail, depots, power and factories first.' },
};
/** Enemy fighters covering the target shoot down incoming strikes. */
export const AIR_DEFENSE = { PER_AIR_WING: 0.09, MAX: 0.7 };

// ---------------------------------------------------------------- air force
export const AIR_TYPES = ['air', 'bomber'] as const;
export const AIR = {
  RANGE: { air: 1300, bomber: 2800 } as Record<string, number>, // km from the airbase
  PLANES: { air: 24, bomber: 16 } as Record<string, number>,    // aircraft in a full squadron
  MAX_WING: 8,              // squadrons per air wing
  SUPERIORITY: 0.25,        // attack bonus (and enemy malus 0.8×) for owning the skies over a battle
  CAS: 1.0,                 // ground-support firepower per point of soft/hard attack
  LOSS: 0.014,              // share of a squadron lost per day when the enemy holds the sky (less when contested)
  BOMB_LOSS: 0.02,          // bombers over defended territory
  REFIT: 0.035,             // share of losses replaced per day while based (paid)
  REBASE_DAYS: 2,
  BOMB_TROOPS: 0.0009,      // share of troops in the target province lost per point of bombing per day
  BOMB_BUILDING: 14,        // bombing points per building level destroyed
  NAVAL_STRIKE: 0.0012,     // share of an enemy fleet sunk per point of naval strike per day
  CARRIER_AIR: 14,          // air superiority one carrier battle group adds over its waters
  SAM_AIR: 4,               // air-defence value of one SAM battery over its own territory
};
export const AIR_MISSION_INFO: Record<'idle' | 'support' | 'defense' | 'bombing' | 'naval', { label: string; desc: string }> = {
  idle: { label: 'Stand down', desc: 'Stay at the airbase and refit fastest. No sorties.' },
  support: { label: 'Support ground forces', desc: 'Fly over every battle of yours in range: fighters fight for the skies, bombers hit enemy troops.' },
  defense: { label: 'Defend our airspace', desc: 'Intercept enemy raids, drones and missiles over your territory in range, and cover battles fought on your soil.' },
  bombing: { label: 'Bomb a province', desc: 'Hit the troops, factories, power and railways of one enemy province in range (right-click it).' },
  naval: { label: 'Naval strike', desc: 'Attack enemy ships in one sea zone in range and help your fleets control it (right-click a sea zone).' },
};
export const NUKE = {
  programCost: 350, programDays: 900,   // a nuclear programme: years of work and a fortune
  warheadCost: 60, warheadDays: 180,    // each ICBM with its warhead
  kill: 0.85, nearbyKill: 0.15, popLoss: 0.35, devLoss: 0.5,
  embargoDays: 3650,                    // the whole world cuts trade with you for 10 years
  relations: -80, stability: -25, warSupport: -25,
};
/** Strategic arsenals at the start (abstracted: each is a usable strategic strike). */
export const START_NUKES: Record<string, number> = { USA: 40, RUS: 40, CHN: 15, FRA: 8, GBR: 8, IND: 5, PAK: 5, ISR: 3, PRK: 2 };

// ---------------------------------------------------------------- government: policies, decrees, focus, espionage
/** Effects a policy, decree or focus can have. Multipliers default to 1, additive values to 0. */
export interface GovEffect {
  growth?: number;        // + yearly productivity growth
  stability?: number;     // + stability target
  warSupport?: number;    // + war support target
  output?: number;        // × national output
  services?: number;      // × civilian services cost
  admin?: number;         // × administration cost
  taxEff?: number;        // × tax collection
  trade?: number;         // × trade-agreement income
  tariff?: number;        // + tariff income as share of output
  imports?: number;       // × import prices
  manpower?: number;      // × manpower pool and regrowth
  morale?: number;        // + troop morale target
  upkeep?: number;        // × military wages & maintenance
  recruit?: number;       // × recruitment price
  research?: number;      // × research speed
  construction?: number;  // × construction cost
  ops?: number;           // × field-operations cost
  popGrowth?: number;     // + yearly population growth
}
export interface PolicyOption { label: string; desc: string; effect: GovEffect }
export const POLICY_AREAS: Record<'economy' | 'trade' | 'labour' | 'conscription' | 'press', { label: string; default: string; options: Record<string, PolicyOption> }> = {
  economy: { label: 'Economic model', default: 'mixed', options: {
    market: { label: 'Free market', desc: 'Private enterprise leads. Faster growth and cheaper services, but inequality costs stability.', effect: { growth: 0.004, stability: -3, services: 0.92 } },
    mixed: { label: 'Mixed economy', desc: 'The balanced default.', effect: {} },
    planned: { label: 'State planning', desc: 'The state directs industry: cheaper construction and recruitment, slower growth, steadier society.', effect: { growth: -0.003, stability: 3, construction: 0.85, recruit: 0.9, output: 0.98 } },
  } },
  trade: { label: 'Trade policy', default: 'balanced', options: {
    free: { label: 'Free trade', desc: 'No tariffs: trade agreements earn 30% more and imports are cheaper.', effect: { trade: 1.3, imports: 0.92, growth: 0.002 } },
    balanced: { label: 'Balanced trade', desc: 'Moderate tariffs. The default.', effect: {} },
    protectionist: { label: 'Protectionism', desc: 'High tariffs raise revenue (1.5% of output) but cut trade income and make imports dear.', effect: { trade: 0.65, tariff: 0.015, imports: 1.25, growth: -0.002 } },
  } },
  labour: { label: 'Labour law', default: 'standard', options: {
    long: { label: 'Long hours', desc: '+5% output, but workers resent it.', effect: { output: 1.05, stability: -7 } },
    standard: { label: 'Standard week', desc: 'The default.', effect: {} },
    welfare: { label: 'Welfare state', desc: 'Generous benefits: services cost 25% more, but stability and population growth rise.', effect: { services: 1.25, stability: 8, popGrowth: 0.002 } },
  } },
  conscription: { label: 'Conscription', default: 'limited', options: {
    volunteer: { label: 'Volunteer army', desc: 'Professionals only: 40% less manpower and 10% higher wages, but better morale.', effect: { manpower: 0.6, upkeep: 1.1, morale: 0.08, stability: 2 } },
    limited: { label: 'Limited conscription', desc: 'The default.', effect: {} },
    universal: { label: 'Universal service', desc: 'Everyone serves: 80% more manpower, −3% output and some resentment.', effect: { manpower: 1.8, output: 0.97, stability: -3, warSupport: 5 } },
  } },
  press: { label: 'Media', default: 'regulated', options: {
    free: { label: 'Free press', desc: 'Open debate speeds research (+15%) but criticises wars.', effect: { research: 1.15, warSupport: -8, stability: -1 } },
    regulated: { label: 'Regulated media', desc: 'The default.', effect: {} },
    state: { label: 'State media', desc: 'Propaganda keeps people loyal and wars popular, but innovation suffers (−10% research).', effect: { research: 0.9, warSupport: 10, stability: 2 } },
  } },
};
export const POLICY_COOLDOWN = 180;       // days before an area can be changed again
export const POLICY_CHANGE_STABILITY = 3; // stability cost of any change
export const SERVICES_RANGE = [0.5, 1.5] as const;

export interface DecreeSpec { label: string; desc: string; days: number; cooldown: number; cost: number; warOnly?: boolean; effect?: GovEffect; instant?: { treasury?: number; stability?: number; prices?: number; debtAt?: number } }
/** Costs are shares of yearly output. Instant effects apply once; `effect` lasts `days`. */
export const DECREES: Record<string, DecreeSpec> = {
  austerity: { label: 'Austerity drive', desc: 'Cut services and administration by 15% for a year. Unpopular.', days: 365, cooldown: 540, cost: 0, effect: { services: 0.85, admin: 0.85, stability: -8, growth: -0.002 } },
  stimulus: { label: 'Stimulus package', desc: 'Pump money into the economy: +1% growth for a year.', days: 365, cooldown: 540, cost: 0.04, effect: { growth: 0.01, stability: 2 } },
  printMoney: { label: 'Print money', desc: 'Create 5% of output out of thin air. Prices rise 6% at once.', days: 0, cooldown: 365, cost: 0, instant: { treasury: 0.05, prices: 0.06, stability: -2 } },
  anticorruption: { label: 'Anti-corruption campaign', desc: '+6% tax collection for a year; the purges unsettle the elite.', days: 365, cooldown: 720, cost: 0.015, effect: { taxEff: 1.06, stability: -2 } },
  propaganda: { label: 'Propaganda campaign', desc: '+15 war support and +3 stability for six months.', days: 180, cooldown: 365, cost: 0.008, effect: { warSupport: 15, stability: 3 } },
  festival: { label: 'National celebration', desc: 'A national holiday: +6 stability at once.', days: 0, cooldown: 365, cost: 0.01, instant: { stability: 6 } },
  warBonds: { label: 'War bonds', desc: 'Patriotic citizens lend 8% of output at just 2% interest.', days: 0, cooldown: 365, cost: 0, warOnly: true, instant: { debtAt: 0.08 } },
  rationing: { label: 'Wartime rationing', desc: 'Field operations cost 25% less for a year; civilians suffer.', days: 365, cooldown: 365, cost: 0, warOnly: true, effect: { ops: 0.75, stability: -5, warSupport: 3 } },
  buildingDrive: { label: 'Construction drive', desc: 'Construction costs 20% less for a year.', days: 365, cooldown: 540, cost: 0.02, effect: { construction: 0.8 } },
};

export const FOCUS: Record<'industry' | 'agriculture' | 'commerce' | 'military', { label: string; desc: string }> = {
  industry: { label: 'Industry', desc: 'Factories here produce 30% more and steel output +30%.' },
  agriculture: { label: 'Agriculture', desc: 'Food output +50%; well-fed regions are calmer (+0.5 stability each).' },
  commerce: { label: 'Commerce', desc: 'Markets and services: +6% output and +10% taxes here.' },
  military: { label: 'Military', desc: 'Garrison region: 2× manpower from here, +40% supply throughput, units recruited here 15% cheaper.' },
};
export const FOCUS_CHANGE_COST = 2;  // $B

export const SPY = {
  NETWORK_COST: 3, NETWORK_GAIN: 0.2, DECAY_PER_MONTH: 0.01,
  OPS: {
    steal: { label: 'Steal technology', need: 0.4, cost: 4, desc: 'Copy their research: +25% progress on your current technology.' },
    sabotage: { label: 'Sabotage industry', need: 0.4, cost: 5, desc: 'Destroy a factory, power plant or depot in one of their provinces.' },
    unrest: { label: 'Incite unrest', need: 0.3, cost: 3, desc: 'Fund dissidents: −6 stability for them, +15 resistance in their occupied lands.' },
    cyber: { label: 'Cyber attack', need: 0.5, cost: 6, desc: 'Hack their grid and logistics: −3% output and −20% supply throughput for 60 days.' },
    coup: { label: 'Sponsor a coup', need: 0.8, cost: 15, desc: 'Back disloyal generals: their stability −20, opposition +25, legitimacy −20, armies lose organisation.' },
    intel: { label: 'Map their military', need: 0.2, cost: 2, desc: 'Better intelligence on them (+15% intel quality for battle estimates).' },
  } as Record<string, { label: string; need: number; cost: number; desc: string }>,
};

export const AID_AMOUNTS = [5, 20, 50];

// ---------------------------------------------------------------- regime: population, opposition, propaganda, repression
export const GROUPS: Record<'workers' | 'middle' | 'business' | 'military' | 'clergy' | 'youth', { label: string; weight: number; desc: string }> = {
  workers: { label: 'Workers', weight: 0.3, desc: 'Factory and farm labour. Care about taxes, wages, food and public services.' },
  middle: { label: 'Middle class', weight: 0.2, desc: 'Professionals and shopkeepers. Hate inflation and repression; like stability and services.' },
  business: { label: 'Business elite', weight: 0.15, desc: 'Owners and financiers. Want low taxes, free markets and open trade.' },
  military: { label: 'Officer corps', weight: 0.15, desc: 'Want a big budget, victories and respect. Low loyalty means coup risk.' },
  clergy: { label: 'Traditionalists', weight: 0.1, desc: 'Religious and rural conservatives. Like order, faith and tradition; dislike a free press.' },
  youth: { label: 'Students & youth', weight: 0.1, desc: 'Idealistic and restless. Hate censorship, conscription and police; fuel protest movements.' },
};
export type GroupKey = keyof typeof GROUPS;

/** Ongoing propaganda campaigns: yearly cost as a share of output; group approval and other effects (per month). */
export const PROPAGANDA: Record<string, { label: string; desc: string; cost: number; groups: Partial<Record<GroupKey, number>>; legitimacy?: number; opposition?: number; warSupport?: number; warOnly?: boolean }> = {
  cult: { label: 'Cult of personality', desc: 'Portraits, statues and songs: the leader is the nation.', cost: 0.004, groups: { clergy: 2, youth: -4, middle: -2 }, legitimacy: 2.5 },
  pride: { label: 'National pride', desc: 'Flags, anthems and a glorious history for everyone.', cost: 0.003, groups: { workers: 4, middle: 3, clergy: 4, military: 3, business: 1, youth: 1 } },
  miracle: { label: 'Economic miracle', desc: 'Statistics, ribbon-cuttings and promises of prosperity.', cost: 0.003, groups: { middle: 6, business: 5, workers: 2 } },
  army: { label: 'Glory of the armed forces', desc: 'Parades and war films. Recruits enlist proudly.', cost: 0.003, groups: { military: 9, youth: 2 }, warSupport: 8 },
  bread: { label: 'Bread and circuses', desc: 'Free concerts, football and cheap bread.', cost: 0.006, groups: { workers: 9, youth: 5, middle: 1 } },
  faith: { label: 'Faith and tradition', desc: 'Religion and family values in schools and broadcasts.', cost: 0.002, groups: { clergy: 10, youth: -3, middle: -1 } },
  enemyWithin: { label: 'Enemy within', desc: 'Blame traitors and foreign agents. Discredits the opposition, but divides society.', cost: 0.002, groups: { youth: -5, middle: -3, clergy: 3, military: 2 }, opposition: -1.2 },
  gates: { label: 'Enemy at the gates', desc: 'Wartime: the homeland is in danger, rally to the flag.', cost: 0.003, groups: { workers: 3, middle: 3, military: 4, clergy: 3 }, warSupport: 15, warOnly: true },
};
/** Effectiveness of propaganda by media policy; more than three campaigns breeds cynicism. */
export const PROPAGANDA_MEDIA: Record<string, number> = { free: 0.6, regulated: 1, state: 1.4 };
export const PROPAGANDA_SATURATION = 3;

export const SECURITY = [
  { label: 'Ordinary police', cost: 0, opposition: 0, unrest: 0, desc: 'Normal policing. No political surveillance.' },
  { label: 'Political police', cost: 0.004, opposition: 0.7, unrest: 6, desc: 'Watches dissidents. Opposition grows more slowly.' },
  { label: 'Secret police', cost: 0.01, opposition: 1.5, unrest: 12, desc: 'Informers everywhere, night arrests. Enables mass arrests. Youth and middle class resent it.' },
  { label: 'Police state', cost: 0.02, opposition: 2.6, unrest: 20, desc: 'Total surveillance. Opposition barely breathes — but nobody loves you.' },
];

/** One-off interior actions. Cost as a share of output. */
export const INTERIOR: Record<string, { label: string; desc: string; cooldown: number; cost: number; needSecurity?: number; needMedia?: string }> = {
  crackdown: { label: 'Crack down on protests', desc: 'Riot police clear the streets: opposition −15, unrest −25 in revolting provinces. Workers and youth −10, infamy +2.', cooldown: 120, cost: 0.002 },
  arrests: { label: 'Mass arrests', desc: 'Round up the opposition: opposition −25. Middle class and youth −15. Needs secret police.', cooldown: 240, cost: 0.004, needSecurity: 2 },
  concessions: { label: 'Grant concessions', desc: 'Raise wages, release prisoners: opposition −10, workers +8, middle +5, legitimacy −3.', cooldown: 180, cost: 0.02 },
  amnesty: { label: 'Political amnesty', desc: 'Free political prisoners: youth +10, middle +6, legitimacy +2, opposition +3.', cooldown: 365, cost: 0 },
  ban: { label: 'Ban the opposition', desc: 'Outlaw opposition parties: opposition −30 now, but it grows 50% faster underground for 2 years. Legitimacy −5. Needs political police.', cooldown: 730, cost: 0, needSecurity: 1 },
  referendum: { label: 'Hold a referendum', desc: 'Ask the people to endorse you. Wins (approval above 55 or legitimacy above 60) give legitimacy +20; a loss costs −15 and emboldens the opposition.', cooldown: 1095, cost: 0.01 },
  rig: { label: 'Rig the elections', desc: 'Stuff the ballot boxes: legitimacy +10 at home, but youth −10, middle −8, infamy +3, and the regime is marked as rigged. Needs state media.', cooldown: 1095, cost: 0.004, needMedia: 'state' },
  purge: { label: 'Purge the officer corps', desc: 'Remove disloyal generals: coup risk gone and officers +15 later, but every army loses 30% organisation now and officers −20.', cooldown: 720, cost: 0 },
  draft: { label: 'Emergency draft', desc: 'Call up reservists: +1% of the population in manpower. Workers −8, youth −12, stability −4.', cooldown: 365, cost: 0 },
  subsidies: { label: 'Food subsidies', desc: 'One year of cheap bread: workers +12, opposition −5. Costs 1.5% of output.', cooldown: 365, cost: 0.015 },
};

export const STAGES = [
  { at: 0, label: 'Quiet', desc: 'No organised opposition.' },
  { at: 20, label: 'Dissent', desc: 'Critics meet in cafés and online. No effect yet.' },
  { at: 40, label: 'Protests', desc: 'Demonstrations in the cities: output −1%.' },
  { at: 60, label: 'Strikes', desc: 'General strikes: output −4%, tax collection −5%, unrest rising everywhere.' },
  { at: 75, label: 'Insurgency', desc: 'Armed groups attack the state: provinces revolt, garrisons take losses.' },
  { at: 90, label: 'Revolution', desc: 'The regime is about to fall. Two months at this level and the government collapses.' },
];
export const REVOLT_AT = 70;    // province unrest at which a province is in open revolt

export const WAR_ECONOMY: Record<'peace' | 'partial' | 'total', { label: string; desc: string; effect: GovEffect; train: number }> = {
  peace: { label: 'Civilian economy', desc: 'Normal economy.', effect: {}, train: 1 },
  partial: { label: 'Partial mobilisation', desc: 'Factories switch shifts to war work: recruiting −10% cost and 15% faster, manpower +25%, output −3%, growth −0.2%, stability −2.', effect: { recruit: 0.9, manpower: 1.25, output: 0.97, growth: -0.002, stability: -2 }, train: 0.85 },
  total: { label: 'Total war economy', desc: 'Everything for the front: recruiting −20% and 30% faster, manpower +50%, wages −10%, but output −8%, growth −0.6%, stability −6 and workers resent it.', effect: { recruit: 0.8, manpower: 1.5, upkeep: 0.9, output: 0.92, growth: -0.006, stability: -6 }, train: 0.7 },
};
export const ROE: Record<'restrained' | 'standard' | 'ruthless', { label: string; desc: string; damage: number }> = {
  restrained: { label: 'Restrained', desc: 'Protect civilians: 7% less damage dealt, occupied lands resist less, infamy fades faster, youth and middle class approve.', damage: 0.93 },
  standard: { label: 'Standard', desc: 'Normal rules of engagement.', damage: 1 },
  ruthless: { label: 'Ruthless', desc: 'No restraint: 12% more damage dealt, but occupied lands resist harder, infamy grows each month at war and youth disapprove.', damage: 1.12 },
};
/** War Room shortcut: give every air wing the same kind of mission. */
export const AIR_MISSIONS: Record<'none' | 'cas' | 'bombing' | 'defense', { label: string; desc: string }> = {
  none: { label: 'Stand down', desc: 'All air wings stay at their bases and refit.' },
  cas: { label: 'Support ground forces', desc: 'All air wings fly over your battles in range: air superiority and strikes on enemy troops.' },
  bombing: { label: 'Strategic bombing', desc: 'All bomber wings bomb the nearest factories, power and railways of the chosen enemy in range; fighter wings escort them.' },
  defense: { label: 'Air defence', desc: 'All air wings guard your own skies: they cover battles on your soil and shoot down enemy raids, drones and missiles.' },
};
export const SAM_COST = 8, SAM_EACH = 0.04, SAM_MAX = 10;
export const MERCENARY_MULT = 2.5;
