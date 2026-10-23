import { describe, it, expect } from 'vitest';
import { newGame } from '../src/engine/setup';
import { tick } from '../src/engine/sim';
import { serialize, deserialize } from '../src/engine/save';
import { runCommand, stateHash } from '../src/engine/commands';
import { neighborsOf, ownedBy } from '../src/engine/world';
import type { GameState } from '../src/engine/types';

/** Simulates host + guest lockstep: one ordered stream of commands and ticks applied to two copies. */
function pair() {
  const host = newGame('sandbox', { seed: 77, nation: 'POL', players: ['DEU'] });
  const guest = deserialize(serialize(host));
  guest.player = 'DEU';
  return { host, guest };
}
type Ev = ['c', string, string, unknown[]] | ['t'];
const apply = (s: GameState, e: Ev) => (e[0] === 't' ? tick(s) : runCommand(s, e[1], e[2], e[3]));

describe('multiplayer lockstep', () => {
  it('two humans start in one world, both human-controlled', () => {
    const { host } = pair();
    expect(host.players).toEqual(['POL', 'DEU']);
    expect(host.nations.POL.isPlayer && host.nations.DEU.isPlayer).toBe(true);
  });

  it('identical command streams keep both copies identical for two years', () => {
    const { host, guest } = pair();
    const stream: Ev[] = [];
    const push = (e: Ev) => { stream.push(e); const rh = apply(host, e); const rg = apply(guest, e); if (e[0] === 'c') expect(rg).toEqual(rh); };
    push(['c', 'POL', 'setTax', [0.28]]);
    push(['c', 'DEU', 'build', [host.nations.DEU.capital, 'factory']]);
    push(['c', 'DEU', 'setProduction', ['smallArms', 3]]);
    push(['c', 'POL', 'doRecruit', ['infantry', host.nations.POL.capital]]);
    push(['c', 'DEU', 'setMobilization', [true]]);
    for (let d = 0; d < 730; d++) {
      if (d === 60) {
        // the guest attacks a neighbour; the host proposes a treaty to the guest
        const t = neighborsOf(host, 'DEU').find((x) => x !== 'POL' && !host.nations[x].isPlayer)!;
        push(['c', 'DEU', 'doDeclareWar', [t]]);
        push(['c', 'POL', 'doTreaty', ['DEU', 'trade']]);
      }
      if (d === 61) {
        const p = host.proposals.find((x) => x.to === 'DEU' && x.kind === 'trade');
        expect(p).toBeTruthy();
        push(['c', 'DEU', 'answerProposal', [p!.id, true]]);
      }
      if (d === 70) {
        for (const a of Object.values(host.armies).filter((x) => x.owner === 'DEU')) {
          const goal = ownedBy(host, host.wars[host.wars.length - 1]?.defenders[0] ?? 'DEU')[0];
          if (goal != null) push(['c', 'DEU', 'moveArmy', [a.id, goal]]);
        }
      }
      push(['t']);
      if (d % 30 === 0) expect(stateHash(guest)).toBe(stateHash(host));
    }
    expect(stateHash(guest)).toBe(stateHash(host));
    expect(host.relations['DEU|POL']?.trade).toBe(true);
    // a mid-game snapshot resumes in lockstep too
    const late = deserialize(serialize(host)); late.player = 'DEU';
    for (let d = 0; d < 60; d++) { tick(host); tick(late); }
    expect(stateHash(late)).toBe(stateHash(host));
    void stream;
  }, 300000);

  it('a player cannot command another player\'s armies or answer their proposals', () => {
    const { host } = pair();
    const polArmy = Object.values(host.armies).find((a) => a.owner === 'POL')!;
    expect(runCommand(host, 'DEU', 'haltArmy', [polArmy.id]).ok).toBe(false);
    runCommand(host, 'POL', 'doTreaty', ['DEU', 'alliance']);
    const p = host.proposals.find((x) => x.to === 'DEU')!;
    expect(runCommand(host, 'POL', 'answerProposal', [p.id, true]).ok).toBe(false);
    expect(runCommand(host, 'DEU', 'answerProposal', [p.id, true]).ok).toBe(true);
    expect(host.relations['DEU|POL'].alliance).toBe(true);
    expect(runCommand(host, 'POL', 'notACommand', []).ok).toBe(false);
  });
});
