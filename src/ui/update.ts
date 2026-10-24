// Keeps every player on the newest version. Browsers keep using a copy of the page for a few
// minutes after the site is updated, and players on different versions may be unable to connect;
// an old copy notices (the site publishes version.json with each build) and loads the newest one.
import { BUILD } from './net/session';

/** The build the website serves right now (null: unknown, e.g. offline or the dev server). */
export async function latestBuild(): Promise<string | null> {
  try {
    const r = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return null;
    const j = (await r.json()) as { build?: unknown };
    return typeof j.build === 'string' ? j.build : null;
  } catch { return null; }
}

/**
 * If this page is an old copy, load the newest version (call only where a reload can't
 * interrupt a game). `hash` is put on the new address, e.g. to reopen a dialog afterwards.
 */
export async function updateIfStale(hash?: string): Promise<boolean> {
  const latest = await latestBuild();
  if (!latest || latest === BUILD) return false;
  try {
    // at most one try per version, in case the site keeps serving the old page for a while
    if (sessionStorage.getItem('wc-reloaded-for') === latest) return false;
    sessionStorage.setItem('wc-reloaded-for', latest);
  } catch { /* no storage: the new address below still avoids the cached copy */ }
  const u = new URL(location.href);
  u.searchParams.set('v', latest); // a new address, so the browser can't reuse its old copy
  if (hash !== undefined && !u.hash.includes('join=')) u.hash = hash;
  location.replace(u.toString());
  return true;
}
