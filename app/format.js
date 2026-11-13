// Pure formatting helpers (unit-tested in Node).
export const fmt = (n, d = 1) => (n == null || !Number.isFinite(n) ? '—' : Number.isInteger(n) ? String(n) : n.toFixed(d));
export const minutes = (n) => (n == null ? '—' : `${fmt(n)} min`);
export const rupees = (n) => (n == null ? 'n/a' : `₹${fmt(n, 2).replace(/\.00$/, '')}`);

// Signed delta with words, so direction never depends on colour alone.
export function deltaText(n, unit = 'min', { lowerIsBetter = true } = {}) {
  if (n == null) return 'n/a';
  if (n === 0) return `no change`;
  const abs = unit === '₹' ? rupees(Math.abs(n)) : `${fmt(Math.abs(n))} ${unit}`;
  const better = lowerIsBetter ? n < 0 : n > 0;
  return `${n > 0 ? '▲ +' : '▼ −'}${abs} (${better ? 'better' : 'worse'})`;
}
export const STATUS_LABEL = { draft: 'Draft', open: 'Open', optimizing: 'Optimising…', proposed: 'Proposed', confirmed: 'Confirmed', cancelled: 'Cancelled', expired: 'Expired' };
export const STRATEGY_LABEL = { balanced: 'Balanced / Fair', fastest: 'Fastest total', cheapest: 'Cheapest', fewest_transfers: 'Fewest transfers', balanced_time_cost: 'Balanced time & cost' };
export const LIMITATION = {
  FARE_IS_STOP_COUNT_ESTIMATE: 'Fares are estimates.', TIMES_ARE_SCHEDULE_ESTIMATES: 'Times are estimates, not live.', TRAFFIC_NOT_REAL_TIME: 'Road times are not real-time traffic.',
  FUEL_IS_ESTIMATE: 'Fuel cost is an estimate from your assumptions.', ROUTING_FALLBACK: 'Distances are straight-line estimates, not road routes.', COST_UNAVAILABLE: 'Cost unavailable, so it was not used.',
  WALKING_IS_STRAIGHT_LINE_ESTIMATE: 'Walking to the first station is estimated.', STEP_FREE_DATA_UNAVAILABLE: 'Step-free data is unavailable, so it was not applied.', ROUTE_GEOMETRY_UNAVAILABLE: 'Route lines could not be drawn.', NO_FEASIBLE_CANDIDATE: 'No location satisfied everyone’s limits.',
};
export const ago = (ts, now = Date.now()) => { const m = Math.floor((now - ts) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ago` : `${Math.floor(m / 1440)} d ago`; };

// Bounding-box projection for the route canvas (no map tiles): lat/lon → x/y in a w×h box with padding.
export function projector(points, w, h, pad = 24) {
  const lats = points.map(p => p[0]), lons = points.map(p => p[1]);
  const [minLat, maxLat, minLon, maxLon] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
  const cos = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
  const spanX = Math.max((maxLon - minLon) * cos, 1e-6), spanY = Math.max(maxLat - minLat, 1e-6);
  const scale = Math.min((w - 2 * pad) / spanX, (h - 2 * pad) / spanY);
  const offX = (w - spanX * scale) / 2, offY = (h - spanY * scale) / 2;
  return ([lat, lon]) => [offX + (lon - minLon) * cos * scale, h - (offY + (lat - minLat) * scale)];
}
