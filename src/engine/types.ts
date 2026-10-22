// Core data model. Everything in GameState is plain JSON so it can be saved verbatim.

export type Terrain = 'plains' | 'forest' | 'jungle' | 'hills' | 'mountains' | 'desert' | 'taiga' | 'arctic';
export type ResourceKind = 'food' | 'steel' | 'oil' | 'rare';
export type EquipKind = 'smallArms' | 'artillery' | 'vehicles' | 'armor' | 'aircraft' | 'ships';
export type UnitType = 'infantry' | 'mechanized' | 'armored' | 'artillery' | 'engineers' | 'recon' | 'air';
export type ShipType = 'destroyer' | 'cruiser' | 'battlegroup' | 'transport';
export type Posture = 'aggressive' | 'balanced' | 'cautious' | 'defensive' | 'mobile' | 'withdrawal';
export type Stance = 'hold' | 'defend' | 'advance' | 'withdraw';
export type Personality = 'defensive' | 'expansionist' | 'industrial' | 'diplomatic' | 'opportunistic' | 'isolationist';
export type ProvinceStatus = 'core' | 'occupied' | 'integrating' | 'autonomous';
export type BuildingKind = 'factory' | 'farm' | 'mine' | 'port' | 'railway' | 'road' | 'power' | 'lab' | 'fort' | 'depot';
export type Weather = 'clear' | 'rain' | 'snow' | 'mud' | 'monsoon' | 'heat' | 'fog' | 'storm';
export type Difficulty = 'tutorial' | 'standard' | 'hard';

/** Static geography (from world.json, never mutated). */
export interface ProvinceGeo {
  id: number; name: string; country: string; path: string;
  x: number; y: number; lx: number; ly: number; lat: number; areaKm: number;
  pop: number; cityPop: number; capital: boolean; terrain: Terrain; elevation: number; rugged: number; river: boolean;
  resources: Record<ResourceKind, number>;
  neighbors: number[]; straits: number[]; seas: number[];
}
export interface CountryGeo {
  id: string; name: string; continent: string; subregion: string; pop: number; gdp: number; income: string; mapcolor: number;
  provinces: number[]; capital: number;
}
export interface SeaGeo { id: number; name: string; x: number; y: number; cells: number; neighbors: number[]; }
export interface WorldGeo { meta: { width: number; height: number; view: number[]; source: string }; countries: CountryGeo[]; provinces: ProvinceGeo[]; seas: SeaGeo[]; }

export interface Buildings { factory: number; farm: number; mine: number; port: number; railway: number; road: number; power: number; lab: number; fort: number; depot: number; }

export interface ProvinceState {
  id: number;
  owner: string;          // legal owner
  controller: string;     // who currently holds it militarily
  status: ProvinceStatus; // relationship to owner
  formerOwner: string;    // original national identity (for resistance / release)
  pop: number;
  dev: number;            // productivity: M IC output per million inhabitants per year
  dev0: number;           // starting productivity (growth ceiling reference)
  infra: number;          // derived: 1 + roads + railways*2 (cached)
  buildings: Buildings;
  damage: number;         // 0..1 war damage
  resistance: number;     // 0..100
  integration: number;    // 0..1 progress when integrating
  capturedDay?: number;
  capturedFrom?: string;
}

export interface Unit {
  id: number;
  type: UnitType;
  strength: number;   // current personnel
  equipment: number;  // 0..1 fraction of full equipment
  experience: number; // 0..1
  org: number;        // 0..1 organisation
  morale: number;     // 0..1
}

export interface Army {
  id: number;
  owner: string;
  name: string;
  location: number;          // province id
  units: Unit[];
  generalId: number | null;
  posture: Posture;
  stance: Stance;
  path: number[];            // remaining province ids to traverse
  moveProgress: number;      // km covered toward path[0]
  supply: number;            // days of supply carried
  entrench: number;          // 0..1 dig-in
  fatigue: number;           // 0..1
  battleId: number | null;
  embarked: null | { route: number[]; dest: number; progress: number; from: number };
  lastSupplyRatio: number;
  lastSupplyCause: string[];
}

export interface Fleet {
  id: number; owner: string; name: string;
  sea: number;          // current sea zone
  ships: Record<ShipType, number>;
  path: number[]; moveProgress: number;
  org: number; homePort: number;
  mission: 'patrol' | 'blockade' | 'escort';
}

export interface General {
  id: number; owner: string; name: string;
  attack: number; defense: number; logistics: number; // 1..5
  trait: GeneralTrait; xp: number; armyId: number | null;
  hireCost: number; available: boolean; // available = in recruitment pool (not yet hired)
}
export type GeneralTrait = 'logistician' | 'mountaineer' | 'armored' | 'entrencher' | 'aggressive' | 'inspiring' | 'cautious' | 'none';

export interface TrainingOrder {
  id: number; type: UnitType; province: number; daysLeft: number; totalDays: number; armyId: number | null;
}
export interface ProductionLine {
  id: number; kind: EquipKind; factories: number; // factories assigned
}
export interface ConstructionOrder {
  id: number; province: number; kind: BuildingKind | 'repair' | 'develop' | 'integrate'; daysLeft: number; totalDays: number; cost: number;
}
export interface Loan { principal: number; rate: number; }

export interface LedgerLine { key: string; label: string; amount: number; detail?: string; }
export interface Budget {
  income: LedgerLine[];
  expenses: LedgerLine[];
  totalIncome: number;
  totalExpense: number;
  net: number;
  output: number;
}

export interface Nation {
  id: string;
  name: string;
  color: string;
  isPlayer: boolean;
  alive: boolean;
  personality: Personality;
  capital: number;
  treasury: number;          // M IC
  debt: number;              // M IC outstanding
  interestRate: number;
  taxRate: number;           // 0.10..0.50
  researchFunding: number;   // M IC per year
  stability: number;         // 0..100
  warSupport: number;        // 0..100
  warExhaustion: number;     // 0..100
  infamy: number;            // aggressive-expansion reputation 0..100
  manpower: number;          // available recruits (personnel)
  mobilization: number;      // 0..1 current; target set by mobilize flag
  mobilize: boolean;
  priceIndex: number;        // inflation index (1 = base)
  stockpile: Record<EquipKind, number>; // M IC of finished equipment
  production: ProductionLine[];
  training: TrainingOrder[];
  shipyard: { id: number; type: ShipType; port: number; daysLeft: number; totalDays: number }[];
  construction: ConstructionOrder[];
  research: { current: string | null; progress: number; done: string[]; queue: string[] };
  techMods: TechMods;
  budget: Budget;            // last computed (annualised)
  ledgerMonth: { income: number; expense: number };
  history: { day: number; treasury: number; output: number; provinces: number; army: number }[];
  overlord: string | null;
  bankrupt: boolean;
  lastFactories: number;
  shortages: Record<ResourceKind, number>; // 0..1 unmet share after trade
  resourceNet: Record<ResourceKind, number>;  // production - demand (units/yr)
  reparations: { to: string; amount: number; until: number }[];
  claims: Record<string, number>; // casus belli against nation -> expiry day
  subjectSince?: number;
  intel: number;             // 0..1 baseline intelligence quality
  lastWarDay: number;
  aiMemory: { targetId?: string; plan?: string; lastDecision?: number; warGoal?: number[] };
  stats: { battlesWon: number; battlesLost: number; casualtiesInflicted: number; casualtiesSuffered: number; provincesCaptured: number; peakProvinces: number; peakOutput: number; };
}

export interface TechMods {
  industry: number; taxEff: number; adminCost: number; supplyRange: number; supplyThroughput: number;
  organisation: number; recon: number; casualtyRecovery: number; integrationSpeed: number;
  quality: Record<EquipKind, number>; equipCost: Record<EquipKind, number>; amphibious: number; researchSpeed: number; growth: number;
}

export interface Relation { value: number; alliance: boolean; nap: number; trade: boolean; truceUntil: number; }

export interface War {
  id: number; attackers: string[]; defenders: string[]; leaderA: string; leaderD: string;
  startDay: number; name: string; justified: boolean;
  scoreA: number; // -100..100 from attacker leader's perspective
  casualtiesA: number; casualtiesD: number; battles: number;
  occupiedByA: number[]; occupiedByD: number[];
}

export interface BattleSide {
  nation: string; armyIds: number[]; general: string | null;
  startStrength: number; startEquip: number; startOrg: number; startMorale: number; startSupply: number;
  strength: number; org: number; morale: number;
  losses: { killed: number; wounded: number; equipment: number; equipmentValue: number };
  units: number;
}
export interface BattleDay {
  day: number; phase: string;
  aStrength: number; dStrength: number; aOrg: number; dOrg: number; aMorale: number; dMorale: number;
  aDamage: number; dDamage: number; events: string[];
}
export interface BattleFactor { label: string; side: 'attacker' | 'defender'; value: number; detail: string; }
export interface Battle {
  id: number; province: number; startDay: number; endDay: number | null;
  attacker: BattleSide; defender: BattleSide;
  attackerPosture: Posture; defenderPosture: Posture;
  terrain: Terrain; weather: Weather; fort: number; river: boolean; strait: boolean; amphibious: boolean;
  timeline: BattleDay[]; factors: BattleFactor[];
  result: null | 'attacker' | 'defender' | 'stalemate';
  summary: string; seed: number; warId: number; fromProvince: number;
  intelEstimate?: { low: number; high: number };
}

export interface GameEvent {
  id: number; day: number; kind: 'battle' | 'war' | 'peace' | 'economy' | 'diplomacy' | 'territory' | 'military' | 'research' | 'construction' | 'info' | 'achievement' | 'unrest';
  text: string; nations: string[]; province?: number; battleId?: number; important?: boolean;
}
export interface PeaceOffer {
  id: number; from: string; to: string; warId: number; day: number;
  terms: PeaceTerms;
}
export interface Proposal { id: number; from: string; to: string; kind: 'alliance' | 'trade' | 'nap' | 'callToArms'; day: number; warId?: number; }
export interface PeaceTerms {
  provinces: number[];   // provinces ceded to the side of `from` ... (taker given by `taker`)
  taker: string | null;
  reparations: number;   // M IC per year for 5 years, paid to taker
  vassalize: boolean;
  annex: boolean;
  white: boolean;
}

export interface VictoryConfig {
  kind: 'domination' | 'economic' | 'hegemony' | 'survival' | 'custom';
  provinceShare?: number;    // domination: share of world provinces
  outputShare?: number;      // economic: share of world output
  region?: string;           // hegemony: subregion name
  regionShare?: number;
  years?: number;            // survival
  customProvinces?: number; customOutput?: number; customYears?: number;
}

export interface GameSettings {
  difficulty: Difficulty;
  victory: VictoryConfig;
  aiAggression: number;   // 0.5..1.5
  startYear: number;
  alternateHistory: 'fractured' | 'blocs' | 'balanced';
  customTreasury?: number;
}

export interface GameState {
  version: number;
  seed: number;
  rng: number;               // rolling RNG state
  day: number;               // days since start
  startYear: number;
  player: string;
  nations: Record<string, Nation>;
  provinces: ProvinceState[];
  armies: Record<number, Army>;
  fleets: Record<number, Fleet>;
  generals: Record<number, General>;
  battles: Record<number, Battle>;
  activeBattles: number[];
  wars: War[];
  relations: Record<string, Relation>; // key "A|B" sorted
  events: GameEvent[];
  peaceOffers: PeaceOffer[];
  proposals: Proposal[];
  market: Record<ResourceKind, { price: number; supply: number; demand: number }>;
  nextId: number;
  settings: GameSettings;
  achievements: Record<string, number>; // id -> day earned
  timeline: GameEvent[];      // important history
  tutorial: { step: number; done: boolean; flags: Record<string, boolean>; startProvinces: number } | null;
  outcome: null | { won: boolean; day: number; reason: string };
  campaign: string;
  notifications: number[];   // event ids not yet seen as toast
  stats: { battles: number; wars: number; peaceDeals: number; annexations: number };
}
