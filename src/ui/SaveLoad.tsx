import { useEffect, useRef, useState } from 'react';
import { Modal, Btn } from './common';
import { listSaves, saveGame, loadGame, deleteSave, importSave, saveCode, fromSaveCode } from './storage';
import type { SaveMeta } from '../engine/save';
import { store } from './store';
import { fmtDate } from '../engine/events';
import { markTutorial } from '../engine/actions';
import { COUNTRY_GEO } from '../engine/geo';

export function SaveLoadDialog({ onClose, loadOnly }: { onClose: () => void; loadOnly?: boolean }) {
  const [saves, setSaves] = useState<SaveMeta[]>([]);
  const [err, setErr] = useState('');
  const [code, setCode] = useState('');
  const [paste, setPaste] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const refresh = () => listSaves().then(setSaves).catch(() => setSaves([]));
  useEffect(() => { refresh(); }, []);
  const g = store.game;
  const doSave = async (slot: string) => {
    if (!g) return;
    try { await saveGame(slot, g); store.act((s) => markTutorial(s, 'saved')); store.toast('Game saved.', 'good'); refresh(); } catch (e) { setErr((e as Error).message); }
  };
  const doLoad = async (slot: string) => {
    try { const s = await loadGame(slot); store.start(s); store.toast(`Loaded: ${s.nations[s.player].name}, ${fmtDate(s, s.day)}.`, 'good'); onClose(); } catch (e) { setErr((e as Error).message); }
  };
  const slots = ['slot1', 'slot2', 'slot3'];
  return (
    <Modal title={loadOnly ? 'Load campaign' : 'Save & load'} onClose={onClose}>
      <p className="muted small">Saves are stored in this browser (IndexedDB). Clearing site data deletes them — use <b>Export</b> to keep a portable file.</p>
      {err && <div className="error">{err}</div>}
      <table className="tbl">
        <thead><tr><th>Slot</th><th>Campaign</th><th>Date</th><th /></tr></thead>
        <tbody>
          {['autosave', 'quick', ...slots].map((slot) => {
            const m = saves.find((x) => x.slot === slot);
            return (
              <tr key={slot}>
                <td>{slot === 'autosave' ? 'Autosave' : slot === 'quick' ? 'Quick save' : `Slot ${slot.slice(4)}`}</td>
                <td>{m ? `${COUNTRY_GEO[m.nation]?.name ?? m.nation}` : <span className="muted">empty</span>}</td>
                <td>{m ? `${fmtDate({ startYear: 2040 }, m.day)} · saved ${new Date(m.savedAt).toLocaleString()}` : ''}</td>
                <td className="right">
                  {!loadOnly && g && slot !== 'autosave' && <Btn small onClick={() => (m ? store.setUI({ confirm: { title: 'Overwrite save?', body: `Replace the save in this slot with the current campaign?`, onOk: () => doSave(slot) } }) : doSave(slot))}>Save</Btn>}
                  {m && <Btn small kind="primary" onClick={() => (g ? store.setUI({ confirm: { title: 'Load this save?', body: 'Your current unsaved progress will be lost.', danger: true, onOk: () => doLoad(slot) } }) : doLoad(slot))}>Load</Btn>}
                  {m && <Btn small kind="ghost" onClick={() => store.setUI({ confirm: { title: 'Delete save?', body: 'This cannot be undone.', danger: true, onOk: async () => { await deleteSave(slot); refresh(); } } })}>Delete</Btn>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="row gap">
        <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: 'none' }} onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          try { const s = await importSave(f); store.start(s); store.toast('Save imported.', 'good'); onClose(); } catch (er) { setErr((er as Error).message); }
        }} />
        <Btn onClick={() => fileRef.current?.click()}>Import save file…</Btn>
        {g && <Btn onClick={async () => { const c = await saveCode(g); setCode(c); try { await navigator.clipboard.writeText(c); store.toast('Save code copied to the clipboard.', 'good'); } catch { store.toast('Select the code below and copy it.', 'info'); } }}>Copy save code</Btn>}
      </div>
      {code && <textarea id="save-code-out" className="savecode" readOnly value={code} onFocus={(e) => e.target.select()} />}
      <h4>Load from a save code</h4>
      <textarea id="save-code-in" className="savecode" placeholder="Paste a save code here" value={paste} onChange={(e) => setPaste(e.target.value)} />
      <div className="row gap end"><Btn kind="primary" disabled={!paste.trim()} onClick={async () => { try { const s = await fromSaveCode(paste); store.start(s); store.toast('Save code loaded.', 'good'); onClose(); } catch (e) { setErr((e as Error).message); } }}>Load code</Btn></div>
      <p className="small muted">A save code is your whole campaign as text: keep it in a note to move a game between browsers or devices.</p>
    </Modal>
  );
}
