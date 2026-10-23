# World Conquest: Rise of an Empire

A browser grand-strategy war game: start as a small nation in a fractured 2040 and build an empire
through economics, logistics, diplomacy and war. React + TypeScript + Vite, with a deterministic
simulation engine kept separate from the UI.

**Play online:** https://westinscollins.github.io/world-conquest/ (deployed automatically from `main` by GitHub Actions).

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # engine tests (vitest)
npm run build      # type-check + production build into dist/
npm run e2e        # browser walkthrough (needs `npm run dev` running)
npm run balance -- serbia 5 15   # headless 15-year world simulation report
```

## What's in the game

- **Real world map.** 182 nations and 769 provinces built from Natural Earth country borders, with provinces seeded on real cities. Adjacency comes from the actual shared borders. Strait crossings link nearby coasts, and 70 named sea zones carry fleets and naval transport. Terrain for each province (plains, forest, jungle, hills, mountains, desert, taiga, arctic) is sampled from NASA Blue Marble colour and elevation imagery, which is also the relief-shaded basemap.
- **Economy.** One currency, Imperial Credits (IC; every figure is in millions). Each province's output comes from population × productivity plus buildings. The budget lists every line with its formula: taxes, trade agreements, resource exports and imports at world prices, civilian services, administration that grows with empire size, occupation costs, unit upkeep, field operations, research, debt interest and reparations. There are loans with a debt ceiling, emergency bonds and default, plus inflation from deficits. Growth has a ceiling, so it can't run away forever. The small-nation start is calibrated to a 100 M treasury, 35 M taxes, ~20 M civilian, ~10 M military and ~+5 M surplus.
- **Military.** Seven formation types and four ship types. All costs come from the per-soldier, equipment and supply prices in `src/engine/config.ts`. Recruiting takes one price (training plus full equipment), manpower and training time; units deploy fully equipped and re-equip themselves in the field, paid from the treasury. Factories make units cheaper and faster to raise. Military strength is a fixed rating (points per formation and warship) that only changes when forces are raised, disbanded or destroyed. The game also has mobilisation, generals with traits and experience, postures, standing orders, and splitting and merging armies.
- **Battles.** They run day by day through phases: initial engagement, main fighting, morale and organisation checks, reserves rotating in and resupply, then advance, stalemate or withdrawal. Combat width limits how many formations fight at once, and attacks are resolved against the target's defence or breakthrough. Terrain, rivers, straits, amphibious landings, weather, forts, entrenchment, supply, generals, recon, air superiority, equipment quality and posture all feed in. Randomness is seeded and capped at ±12% a day. Before attacking you get an intelligence report with an estimated enemy strength range. While a battle runs, casualty numbers rise from it on the map and its running losses are shown on the marker; provinces flash as they change hands, and a war ticker lists captures and losses. The War Room panel shows every war's losses and territory, every battle in progress (change posture, retreat or send reinforcements mid-battle) and gives orders to all armies at once (attack, defend, hold, withdraw). Shift-click armies to move several together. Afterwards the battle report shows casualties (killed and wounded), equipment losses, a replayable timeline, ranked "why this result" factors and lessons.
- **Supply.** It flows from the capital, depots, ports with a sea connection and major cities, through friendly territory. Reach falls off with distance weighted by infrastructure, each province has a throughput limit, and hub capacity is shared between armies. Shortages lower readiness, slow vehicles and cause attrition. The army's supply tab lists each cause and possible fixes, and there's a supply map mode.
- **AI.** 181 AI nations with six personalities. They run their own budgets, build, recruit against perceived threats, garrison borders, ally against common threats, declare war when imperfect intelligence says they're stronger, fight with odds-checked attacks, and negotiate peace. Grace periods, war exhaustion, infamy and a breaker for endless wars keep the world from either freezing or exploding.
- **Diplomacy and conquest.** Trade agreements, non-aggression pacts, defensive alliances with calls to arms, diplomatic missions, ultimatums (a refusal gives you a casus belli), war-score peace deals (provinces, reparations, subject status), truces, subject states and their annexation. Conquered land starts as occupied: low output, resistance and admin costs. You can integrate it (costs money and time), grant autonomy, or release it as a subject. Unrest can lead to uprisings.
- **Research.** 25 technologies in 8 branches, funded from the budget with diminishing returns, plus research institutes.
- **Campaigns.** A guided tutorial (Serbia), five standard starts (small, regional, industrial, large-army and isolated nations), a hard survival start, and custom setup: victory type (domination, economic, regional hegemony, survival, custom objective), alternate-history setting, treasury and seed. Also achievements, statistics, a history timeline and world rankings.
- **Saves.** Autosave every 30 days, a quick-save slot, three manual slots and import/export to a JSON file. Saves are versioned with migrations, and the RNG state is saved too, so a reloaded game plays out identically.
- **Audio.** Original music generated in code with the Web Audio API: separate menu, peace and war moods, crossfaded by game state. Sound effects are synthesized too. No audio files and nothing copyrighted.

## Online multiplayer
Main menu → **Online multiplayer**. The host clicks **Create room** and shares the 6-letter code; others click **Join** and type it. Everyone picks a different nation, then the host starts. All players run the same deterministic simulation in lockstep: the host owns the clock and orders every event; guests' orders go to the host and come back in the shared stream; lost messages are re-sent and a checksum mismatch triggers a full resync. Players can rejoin with the same code.

How players connect depends on where the game runs:
- **Public website (GitHub Pages or any other host):** direct peer-to-peer connections (WebRTC via [PeerJS](https://peerjs.com/) and its free public signalling server). Anyone with the link and the room code can join — no sign-in or approval.
- **Inside claude.ai (Artifact):** the claude.ai live room. Players must be signed in and have the page shared with them with edit/contribute access; public-link visitors cannot join.
- **Tests:** `?transport=local` connects tabs of one browser (BroadcastChannel). `node tests/e2e/peer-server.mjs` runs a local PeerJS server; append `?peerhost=127.0.0.1:9000` to test real WebRTC offline.

```bash
npm run dev &                     # then:
node tests/e2e/multiplayer.mjs    # two-tab test over ?transport=local
node tests/e2e/peer-server.mjs &  # local signalling server, then:
node tests/e2e/multiplayer.mjs http://localhost:5173/ '?peerhost=127.0.0.1:9000'
```

## Controls
Drag to pan, scroll to zoom. **Left-click** selects a province or army. **Right-click** orders the selected army to move or attack, or the selected fleet to sail. **Space** pauses, **1–3** set the speed, **Esc** closes panels.

## Storage note
Saves live in this browser's IndexedDB (with a localStorage fallback). Clearing site data deletes them, so use **Menu → Export save file** to keep a portable copy.

## Data & licences
- Borders, cities, rivers and lakes: [Natural Earth](https://www.naturalearthdata.com/), public domain (`data-raw/`).
- Basemap colour, elevation and water mask: NASA Blue Marble–derived imagery (public domain), via the three-globe example images.
- Every economic and military number is a fictional game-balance value for an alternate-history setting. None of it is real data.
- To regenerate the world data, run `npx tsx scripts/build-world.ts` and `python3 -I scripts/build-basemap.py`.

## Layout
`src/engine/` holds the pure simulation: types, central balance `config.ts`, economy, military, battle, supply, naval, diplomacy, territory, research, AI, sim clock, save. `src/ui/` holds the React interface and `src/audio/` the procedural music. Tests are in `tests/`.
