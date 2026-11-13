// Saved-plan cache (spec §16). Plans are cached on THIS device only, keyed by group, with a timestamp so the UI can warn
// when data is stale. Everything is removed on sign-out. Storage is injected so the logic is testable in Node.
export const STALE_AFTER_MS = 6 * 3600 * 1000;
export function createPlanCache(storage = globalThis.localStorage, now = Date.now) {
  const key = (gid) => `mm.plan.${gid}`;
  return {
    save(gid, plan) { try { storage.setItem(key(gid), JSON.stringify({ savedAt: now(), plan })); return true; } catch { return false; } },
    load(gid) {
      try { const raw = storage.getItem(key(gid)); if (!raw) return null; const v = JSON.parse(raw); return { ...v, stale: now() - v.savedAt > STALE_AFTER_MS }; } catch { return null; }
    },
    // Standard Storage API (length/key): remove every key this app owns.
    clearAll() { try { for (let i = storage.length - 1; i >= 0; i--) { const k = storage.key(i); if (k && k.startsWith('mm.')) storage.removeItem(k); } } catch { /* ignore */ } },
  };
}
