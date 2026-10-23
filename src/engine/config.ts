/**
 * CENTRAL BALANCE CONFIGURATION
 *
 * Every price, rate and modifier in the game derives from the values in this file.
 * Currency: Imperial Credits (IC). All money values are in MILLIONS of IC (M IC).
 * These are fictional game-balance figures, not real-world procurement prices.
 */
import type { BuildingKind, EquipKind, Posture, ResourceKind, ShipType, Terrain, UnitType, Weather, Personality } from './types';

export const SAVE_VERSION = 4;
export const DAYS_PER_YEAR = 365;

// ---------------------------------------------------------------- economy
export const ECON = {
  /** National output (M IC / yr) = OUTPUT_K * GDP^OUTPUT_EXP * popFactor. Calibrated so a 51 bn-GDP nation ≈ 140 M IC. */
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
  /** Per non-core province flat administration (M IC / yr) plus share of its output. */
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
  /** Equipment capacity per factory (M IC of equipment per year) and baseline civilian industry share. */
  FACTORY_CAPACITY: 3.2,
  BASE_INDUSTRY_SHARE: 0.035,
  /** Research: research points per M IC funded, base pts from labs. */
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
  // basePrice: M IC per unit. perLevel: units/yr per resource level, scaled by sqrt(province area / 100,000 km²).
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
  oilPerOutput: 0.0012,   // civilian demand per M IC output
};

// ---------------------------------------------------------------- buildings
export interface BuildingSpec {
  label: string; cost: number; days: number; upkeep: number; max: number;
  output: number;  // flat output M IC / yr added to province
  desc: string; needsCoast?: boolean; steel?: number;
}
export const BUILDINGS: Record<BuildingKind, BuildingSpec> = {
  factory: { label: 'Factory', cost: 14, days: 240, upkeep: 0.35, max: 12, output: 3, steel: 2, desc: '+3 M IC output. Each factory also makes new formations 2.5% cheaper and 3% faster to train (up to 35% / 40%). Consumes steel.' },
  farm: { label: 'Agricultural Estate', cost: 5, days: 120, upkeep: 0.1, max: 6, output: 1.6, desc: '+1 food level, +1.6 M IC output. Food surplus raises stability.' },
  mine: { label: 'Extraction Site', cost: 9, days: 200, upkeep: 0.25, max: 4, output: 1.2, desc: '+50% of province steel/oil/rare yield per level (needs a resource).' },
  port: { label: 'Port', cost: 10, days: 210, upkeep: 0.3, max: 5, output: 1.5, needsCoast: true, desc: 'Sea supply hub, naval base, +trade. Required for naval transport.' },
  railway: { label: 'Railway', cost: 12, days: 240, upkeep: 0.3, max: 3, output: 1.0, steel: 1.5, desc: '+2 infrastructure, +60% supply throughput along the line.' },
  road: { label: 'Highway Network', cost: 4, days: 90, upkeep: 0.08, max: 4, output: 0.6, desc: '+1 infrastructure: faster movement and better supply.' },
  power: { label: 'Power Plant', cost: 11, days: 220, upkeep: 0.3, max: 3, output: 1.0, desc: '+12% province output and +15% factory capacity in province.' },
  lab: { label: 'Research Institute', cost: 10, days: 200, upkeep: 0.5, max: 3, output: 0.3, desc: `+${4} research points/yr and +8% research efficiency.` },
  fort: { label: 'Fortifications', cost: 6, days: 150, upkeep: 0.15, max: 5, output: 0, desc: '+12% defence per level for defenders in this province.' },
  depot: { label: 'Supply Depot', cost: 5, days: 90, upkeep: 0.2, max: 1, output: 0, desc: 'Regional supply hub; extends supply into the front.' },
};
export const REPAIR_COST_PER_DAMAGE = 30; // M IC to repair 100% damage scaled by province output share
export const DEVELOP = { cost: 8, days: 180, boost: 0.04 };
export const INTEGRATE = { costPerOutput: 0.6, minCost: 3, days: 270 };

// ---------------------------------------------------------------- military
export const MIL = {
  SOLDIER_WAGE: 0.00028,   // M IC per soldier per year
  RECRUIT_PER_SOLDIER: 0.00032, // induction and training per soldier
  EQUIP_MAINT: 0.07,       // share of equipment value per year
  SUPPLY_PRICE: 0.0011,    // M IC per supply unit (food, ammo, spares)
  FUEL_PRICE_PER_OIL: 0.0012, // M IC per fuel unit at oil base price
  PEACE_SUPPLY_FACTOR: 0.45, // garrison consumption share at peace (paid in upkeep)
  TRANSPORT_COST_PER_ZONE: 0.1, // M IC per brigade per sea zone
  OPS_COST_SHARE: 0.65,  // share of full campaign fuel/ammunition cost charged while moving or fighting
  TRANSPORT_DAYS_PER_ZONE: 3,
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
  air: { points: 25, label: 'Air Wing', short: 'AIR', personnel: 450, equip: { aircraft: 11.0 }, trainDays: 150, speed: 200, soft: 7, hard: 5, defense: 0, breakthrough: 0, hardness: 0, piercing: 6, recon: 3, air: 10, supply: 1.2, fuel: 2.2, width: 0, support: true, desc: 'Fighters and strike aircraft. Air superiority and close support; grounded by storms.' },
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
  AMPHIBIOUS_PENALTY: 0.6,
  OUT_OF_SUPPLY_ATTACK: 0.45, // multiplier at 0 supply
  GENERAL_PER_SKILL: 0.05,
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
