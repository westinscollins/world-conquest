import type { GameState } from './types';
import { ownedBy, isAtWar, controlledBy } from './world';
import { addEvent } from './events';

export interface TutorialStep { title: string; text: string; hint: string; done: (s: GameState) => boolean; }

const P = (s: GameState) => s.nations[s.player];

export const TUTORIAL: TutorialStep[] = [
  { title: 'Welcome, Commander', text: 'You lead Serbia, a small landlocked nation with 100 M IC in the treasury. The time controls are at the top right — the clock is paused. Open the Economy panel (left bar) to review where your money comes from and goes.', hint: 'Click "Economy" in the left navigation.', done: (s) => !!s.tutorial?.flags.economy },
  { title: 'Read the budget', text: 'Taxes bring in about 35 M IC a year. Civilian services and administration cost ~20 M, the army ~10 M: a surplus of roughly 5 M. Hover any line to see how it is calculated. Raising taxes increases revenue but lowers stability and growth.', hint: 'Fund research: open "Research" and pick a technology.', done: (s) => !!P(s).research.current || P(s).research.done.length > 3 },
  { title: 'Build the economy', text: 'Infrastructure takes time and money but pays off. Select one of your provinces on the map and start a construction project — a Highway Network is cheap and improves movement and supply.', hint: 'Click a Serbian province → Construction → Build.', done: (s) => P(s).construction.length > 0 },
  { title: 'Raise an army', text: 'Recruiting costs money and manpower up front; the brigade then trains for weeks and draws its equipment from your stockpile, which factories produce over time. Under-equipped units fight badly.', hint: 'Military panel → Recruit → Infantry Brigade.', done: (s) => P(s).training.length > 0 || Object.values(s.armies).filter((a) => a.owner === s.player).reduce((t, a) => t + a.units.length, 0) > 7 },
  { title: 'Appoint a general', text: 'Generals add attack, defence and logistics skill, and traits such as Logistician or Mountaineer. Hire one from the pool and assign them to an army.', hint: 'Military panel → Generals → Hire, then assign.', done: (s) => Object.values(s.generals).filter((g) => g.owner === s.player && !g.available && g.armyId != null).length >= 2 },
  { title: 'Move to the border', text: 'Select an army (click its counter on the map), then right-click a destination. Armies move only through connected provinces; travel time depends on terrain, weather and infrastructure.', hint: 'Select your army, right-click a border province.', done: (s) => !!s.tutorial?.flags.moved },
  { title: 'Check supply', text: 'Armies consume supplies daily. Supply flows from your capital, depots and ports through roads and railways. Far from a hub, or in poor infrastructure, armies lose readiness and suffer attrition. Open an army\'s supply report.', hint: 'Select an army → Supply tab.', done: (s) => !!s.tutorial?.flags.supply },
  { title: 'Go to war', text: 'Pick a weak neighbour. Open the Diplomacy panel, inspect their strength, and declare war. Unjustified wars cost stability and reputation — an ultimatum first can give you a casus belli.', hint: 'Diplomacy → select a neighbour → Declare war.', done: (s) => isAtWar(s, s.player) },
  { title: 'Win a battle', text: 'Right-click an enemy province with an army selected: you will see an intelligence report with estimated enemy strength, terrain and risks. Choose a posture and attack. Watch the battle unfold day by day.', hint: 'Select army → right-click enemy province → choose posture → Attack.', done: (s) => P(s).stats.battlesWon >= 1 },
  { title: 'Occupy territory', text: 'Victorious armies advance and occupy the province. Occupation raises your war score, but occupied land produces little until a peace treaty transfers it.', hint: 'Move into an enemy province.', done: (s) => controlledBy(s, s.player).some((p) => s.provinces[p].owner !== s.player) },
  { title: 'Negotiate peace', text: 'Open the war in the Diplomacy panel and propose terms. Each demand costs war score; the enemy accepts if your score (plus their war-weariness) covers it.', hint: 'Diplomacy → Wars → Negotiate peace.', done: (s) => ownedBy(s, s.player).length > (s.tutorial?.startProvinces ?? 2) },
  { title: 'Integrate your conquest', text: 'New provinces start under military occupation: low output, resistance and administrative costs. Integrate them (costs money and time) or grant autonomy. Larger empires cost more to run.', hint: 'Select the new province → Integrate.', done: (s) => ownedBy(s, s.player).some((p) => s.provinces[p].status === 'integrating' || s.provinces[p].status === 'autonomous') },
  { title: 'Save your campaign', text: 'The game autosaves every 30 days. Save manually from the menu (top right) to keep a checkpoint.', hint: 'Menu → Save.', done: (s) => !!s.tutorial?.flags.saved },
];

export function tutorialCheck(s: GameState) {
  const t = s.tutorial;
  if (!t || t.done) return;
  let guard = 0;
  while (t.step < TUTORIAL.length && TUTORIAL[t.step].done(s) && guard++ < 20) {
    t.step++;
    if (t.step < TUTORIAL.length) addEvent(s, 'info', `Tutorial: ${TUTORIAL[t.step].title}`, [s.player]);
  }
  if (t.step >= TUTORIAL.length) { t.done = true; addEvent(s, 'achievement', 'Tutorial complete! The Balkans are yours to shape.', [s.player], { important: true }); }
}
