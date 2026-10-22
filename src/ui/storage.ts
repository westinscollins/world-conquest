// Save storage: IndexedDB (large quota) with a localStorage fallback. Saves are gzip-compressed
// when the browser supports CompressionStream. Saves live in this browser only — use
// Export to keep a portable copy.
import type { GameState } from '../engine/types';
import { serialize, deserialize, type SaveMeta } from '../engine/save';
import { fmtDate } from '../engine/events';

const DB = 'world-conquest';
const STORE = 'saves';

function openDB(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    if (typeof indexedDB === 'undefined') return rej(new Error('IndexedDB unavailable'));
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbPut(key: string, value: unknown) {
  const db = await openDB();
  await new Promise<void>((res, rej) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(value, key); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
}
async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDB();
  return new Promise((res, rej) => { const tx = db.transaction(STORE, 'readonly'); const r = tx.objectStore(STORE).get(key); r.onsuccess = () => res(r.result as T); r.onerror = () => rej(r.error); });
}
async function idbDel(key: string) {
  const db = await openDB();
  await new Promise<void>((res, rej) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).delete(key); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
}

async function compress(text: string): Promise<Blob | string> {
  if (typeof CompressionStream === 'undefined') return text;
  const cs = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return await new Response(cs).blob();
}
async function decompress(v: Blob | string): Promise<string> {
  if (typeof v === 'string') return v;
  const ds = v.stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(ds).text();
}

export async function listSaves(): Promise<SaveMeta[]> {
  try {
    const metas = (await idbGet<SaveMeta[]>('__index')) ?? [];
    return metas.sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    const raw = localStorage.getItem('wc-index');
    return raw ? JSON.parse(raw) : [];
  }
}

export async function saveGame(slot: string, g: GameState, name?: string): Promise<SaveMeta> {
  const meta: SaveMeta = { slot, name: name ?? (slot === 'autosave' ? 'Autosave' : `${g.nations[g.player].name} — ${fmtDate(g, g.day)}`), nation: g.player, day: g.day, savedAt: Date.now(), version: g.version, campaign: g.campaign };
  const text = serialize(g);
  try {
    await idbPut(`save:${slot}`, await compress(text));
    const idx = ((await idbGet<SaveMeta[]>('__index')) ?? []).filter((m) => m.slot !== slot);
    idx.push(meta);
    await idbPut('__index', idx);
  } catch {
    localStorage.setItem(`wc-save:${slot}`, text);
    const idx = (JSON.parse(localStorage.getItem('wc-index') || '[]') as SaveMeta[]).filter((m) => m.slot !== slot);
    idx.push(meta);
    localStorage.setItem('wc-index', JSON.stringify(idx));
  }
  return meta;
}

export async function loadGame(slot: string): Promise<GameState> {
  let text: string | null = null;
  try {
    const v = await idbGet<Blob | string>(`save:${slot}`);
    if (v != null) text = await decompress(v);
  } catch { /* fall through */ }
  if (text == null) text = localStorage.getItem(`wc-save:${slot}`);
  if (text == null) throw new Error('Save not found.');
  return deserialize(text);
}

export async function deleteSave(slot: string) {
  try {
    await idbDel(`save:${slot}`);
    const idx = ((await idbGet<SaveMeta[]>('__index')) ?? []).filter((m) => m.slot !== slot);
    await idbPut('__index', idx);
  } catch {
    localStorage.removeItem(`wc-save:${slot}`);
    const idx = (JSON.parse(localStorage.getItem('wc-index') || '[]') as SaveMeta[]).filter((m) => m.slot !== slot);
    localStorage.setItem('wc-index', JSON.stringify(idx));
  }
}

export function exportSave(g: GameState) {
  const blob = new Blob([serialize(g)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `world-conquest-${g.player}-${g.day}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
export async function importSave(file: File): Promise<GameState> {
  return deserialize(await file.text());
}
