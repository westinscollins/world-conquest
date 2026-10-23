// Timers that keep running while the tab is in the background. Browsers slow page timers in a
// hidden tab to once a second, and after five minutes to once a minute: an online game whose host
// switched tabs would freeze and everyone's connections would time out. Timers inside a worker
// are not slowed down, so a tiny worker keeps time and the page runs the callbacks when it says so.

type Fn = () => void;
const SRC = 'const t=new Map();onmessage=({data:[op,id,ms]})=>{if(op===1)t.set(id,setInterval(()=>postMessage(id),ms));'
  + 'else if(op===2)t.set(id,setTimeout(()=>{t.delete(id);postMessage(id)},ms));else{clearTimeout(t.get(id));clearInterval(t.get(id));t.delete(id)}}';
const fns = new Map<number, { fn: Fn; once: boolean }>();
let seq = 0;
let worker: Worker | null | undefined;

function ticker(): Worker | null {
  if (worker !== undefined) return worker;
  worker = null;
  try {
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
    const w = new Worker(URL.createObjectURL(new Blob([SRC], { type: 'text/javascript' })));
    w.onmessage = (e: MessageEvent<number>) => {
      const t = fns.get(e.data);
      if (!t) return;
      if (t.once) fns.delete(e.data);
      t.fn();
    };
    worker = w;
  } catch { /* no workers here (tests, strict security policy): plain timers */ }
  return worker;
}

/** Like setInterval, but not slowed down in a background tab. Returns a function that stops it. */
export function every(ms: number, fn: Fn): () => void {
  const w = ticker();
  if (!w) { const h = setInterval(fn, ms); return () => clearInterval(h); }
  const id = ++seq;
  fns.set(id, { fn, once: false });
  w.postMessage([1, id, ms]);
  return () => { if (fns.delete(id)) w.postMessage([0, id, 0]); };
}

/** Like setTimeout, but not slowed down in a background tab. Returns a function that cancels it. */
export function after(ms: number, fn: Fn): () => void {
  const w = ticker();
  if (!w) { const h = setTimeout(fn, ms); return () => clearTimeout(h); }
  const id = ++seq;
  fns.set(id, { fn, once: true });
  w.postMessage([2, id, ms]);
  return () => { if (fns.delete(id)) w.postMessage([0, id, 0]); };
}

/** A promise that resolves after `ms`, background-safe. */
export const sleep = (ms: number) => new Promise<void>((r) => { after(ms, r); });
