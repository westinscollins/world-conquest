import { useStore } from './ui/store';
import { MainMenu } from './ui/MainMenu';
import { MapView } from './ui/MapView';
import { TopBar } from './ui/TopBar';
import { LeftNav, MapModes, EventLog, Toasts, ConfirmDialog, TutorialCard, OutcomeModal, OnlineBar, LiveTicker, ArmyBar, DecisionCard, useHotkeys } from './ui/Shell';
import { ProvincePanel } from './ui/ProvincePanel';
import { ArmyPanel, FleetPanel } from './ui/ArmyPanel';
import { AirWingPanel } from './ui/AirWingPanel';
import { IntelDialog } from './ui/IntelDialog';
import { BattleReport } from './ui/BattleReport';
import { BattleView } from './ui/BattleView';
import { InvasionPlanner } from './ui/InvasionPlanner';

export default function App() {
  const { g, ui } = useStore();
  useHotkeys();
  if (ui.screen === 'menu' || !g) return (<><MainMenu /><ConfirmDialog /><Toasts /></>);
  return (
    <div className="game">
      <MapView />
      <TopBar />
      <OnlineBar />
      <LeftNav />
      {/* (a piece that was just destroyed falls back to the province view instead of an empty panel) */}
      {ui.selectedArmy != null && g.armies[ui.selectedArmy] ? <ArmyPanel /> : ui.selectedFleet != null && g.fleets[ui.selectedFleet] ? <FleetPanel /> : ui.selectedWing != null && g.airWings?.[ui.selectedWing] ? <AirWingPanel /> : <ProvincePanel />}
      <MapModes />
      <ArmyBar />
      <EventLog />
      <TutorialCard />
      <DecisionCard />
      <LiveTicker />
      <Toasts />
      <IntelDialog />
      <BattleReport />
      <BattleView />
      <InvasionPlanner />
      <OutcomeModal />
      <ConfirmDialog />
    </div>
  );
}
