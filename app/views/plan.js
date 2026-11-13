import { h, badge } from '../dom.js';
import { minutes, rupees, fmt, deltaText, STRATEGY_LABEL, LIMITATION } from '../format.js';
import { routeCanvas } from './mapCanvas.js';
import { metroCanvas } from './metroMap.js';

const LINE_NAME = { Purple: 'Purple', Green: 'Green', Yellow: 'Yellow', Pink: 'Pink' };

function routeSummary(j, mode) {
  if (mode === 'BIKE') return `${fmt(j.detail.distanceKm)} km by road${j.detail.quality === 'fallback' ? ' (straight-line estimate)' : ''}`;
  const d = j.detail; const walk = d.access.walkMin > 0 ? `walk ${fmt(d.access.walkMin)} min to ${d.access.station}, then ` : '';
  if (d.stopCount === 0) return d.access.walkMin > 0 ? `walk ${fmt(d.access.walkMin)} min — already at the meetup station` : 'already at the meetup station';
  return `${walk}${d.linesUsed.map(l => `${LINE_NAME[l] ?? l} line`).join(' → ')}, ${d.stopCount} stops${d.interchangeStations.length ? `, change at ${d.interchangeStations.join(' & ')}` : ', no change'}`;
}

export function renderPlan(plan, { names, mode, stale, isOwner, onConfirm, onPhrase }) {
  const r = plan.result, rec = r.recommended;
  if (!rec) return h('section', { class: 'card' }, h('h2', {}, 'No meetup found'), h('p', {}, 'No location satisfied everyone’s hard limits. Relax a limit or try another strategy.'), limitations(r));
  const m = rec.metrics;
  const maxBurden = Math.max(...rec.journeys.map(j => j.burdenMin), 1);
  const rows = rec.journeys.map(j => h('tr', {}, h('th', { scope: 'row' }, names[j.participantId] ?? 'Participant', j.participantId === m.longestParticipantId ? ' ★' : ''),
    h('td', {}, h('div', { class: 'bar', role: 'presentation' }, h('span', { style: `width:${Math.round(j.burdenMin / maxBurden * 100)}%` })), minutes(j.timeMin)),
    h('td', {}, j.cost == null ? 'n/a' : rupees(j.cost)), h('td', {}, mode === 'METRO' ? String(j.interchanges) : '—'), h('td', {}, routeSummary(j, mode))));
  const canvas = mode === 'BIKE' ? routeCanvas(rec.journeys, rec, names) : metroCanvas(rec.journeys, rec.label, names);
  const phraseOut = h('div', { class: 'phrased', 'aria-live': 'polite' });
  let chosen = null; const selectedVenue = () => chosen;

  return h('section', { class: 'card plan' },
    h('div', { class: 'plan-head' }, h('div', {}, h('h2', {}, rec.areaName ? `Meet near ${rec.areaName}` : `Meet at ${rec.label}`), h('p', { class: 'hint' }, `Plan v${plan.version} · ${STRATEGY_LABEL[r.strategy] ?? r.strategy}${r.routeStrategy && r.routeStrategy !== 'fastest' ? ` · routes: ${r.routeStrategy === 'fewest_transfers' ? 'fewest changes' : 'lowest fare'}` : ''} · ${r.feasibleCount} feasible locations`)), badge(plan.status === 'confirmed' ? '✔ Confirmed' : plan.status === 'superseded' ? 'Superseded' : 'Proposed', plan.status)),
    r.warnings.includes('ROUTING_FALLBACK') ? h('p', { class: 'banner warn', role: 'status' }, 'ⓘ Distances here are straight-line estimates (about 1.35× the direct distance at 25 km/h), not real road routes. Treat times as rough.') : null,
    stale ? h('p', { class: 'banner warn', role: 'status' }, '⚠ Someone changed their details after this plan was made. Run the optimisation again for a current plan.') : null,
    h('table', { class: 'data' }, h('caption', {}, 'Each person’s journey'), h('thead', {}, h('tr', {}, ['Who', 'Travel time', 'Cost', 'Changes', 'Route'].map(c => h('th', { scope: 'col' }, c)))), h('tbody', {}, rows)),
    h('p', { class: 'hint' }, '★ = longest journey. Bars are scaled to the longest journey.'),
    canvas ? mapBox(canvas, mode, () => routeCanvas(rec.journeys, rec, names, selectedVenue()), (v) => { chosen = v; }) : null,
    h('dl', { class: 'metrics' },
      ...[['Longest journey', minutes(m.burden.max)], ['Shortest', minutes(m.burden.min)], ['Spread (range)', minutes(m.burden.range)], ['Std deviation', minutes(m.burden.stdDev)], ['Fairness index (Jain)', `${m.burden.jain} (1 = perfectly even)`], ['Group total time', minutes(m.time.total)], ['Estimated group cost', rupees(m.costTotal)]]
        .flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
    h('h3', {}, 'Why this location?'), h('ul', {}, r.explanation.lines.map(l => h('li', {}, l))),
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'secondary', onclick: async (e) => { e.target.disabled = true; try { await onPhrase(phraseOut); } finally { e.target.disabled = false; } } }, 'Reword in plain language'), phraseOut),
    alternatives(r, rec), limitations(r),
    r.routing ? h('p', { class: 'hint' }, `Road routing: ${r.routing.provider}${r.routing.profile ? ` (${r.routing.profile} profile)` : ''} — not real-time traffic.`) : null,
    r.fuelAssumptions ? h('p', { class: 'hint' }, `Fuel assumptions: ${r.fuelAssumptions.mileageKmPerLitre} km/L at ₹${r.fuelAssumptions.fuelPricePerLitre}/L (${r.fuelAssumptions.priceSource}${r.fuelAssumptions.priceDate ? `, ${r.fuelAssumptions.priceDate}` : ''}).`) : null,
    isOwner && plan.status === 'proposed' && !stale ? h('button', { type: 'button', onclick: onConfirm }, 'Confirm this plan') : null);
}

function alternatives(r, rec) {
  const items = [...r.alternatives];
  if (!items.length) return null;
  return h('details', { open: true }, h('summary', {}, 'Compare alternatives'),
    h('table', { class: 'data' }, h('thead', {}, h('tr', {}, ['Location', 'Longest journey', 'Group total', 'Cost'].map(c => h('th', { scope: 'col' }, c)))),
      h('tbody', {}, h('tr', { class: 'current' }, h('th', { scope: 'row' }, `${rec.label} (recommended)`), h('td', {}, minutes(rec.metrics.burden.max)), h('td', {}, minutes(rec.metrics.time.total)), h('td', {}, rupees(rec.metrics.costTotal))),
        items.map(a => h('tr', {}, h('th', { scope: 'row' }, a.label),
          h('td', {}, `${minutes(a.metrics.burden.max)} · ${deltaText(Math.round((a.metrics.burden.max - rec.metrics.burden.max) * 10) / 10)}`),
          h('td', {}, `${minutes(a.metrics.time.total)} · ${deltaText(Math.round((a.metrics.time.total - rec.metrics.time.total) * 10) / 10)}`),
          h('td', {}, rupees(a.metrics.costTotal)))))));
}
function limitations(r) {
  const items = [...new Set(r.warnings)].map(w => LIMITATION[w]).filter(Boolean);
  return items.length ? h('details', {}, h('summary', {}, 'Data limitations'), h('ul', {}, items.map(i => h('li', {}, i)))) : null;
}
const PROVENANCE = { live: ['Live OSM', 'ok'], cached: ['Cached', 'warn'], snapshot: ['Saved snapshot', 'warn'] };
export function renderVenues(v, { mode = 'METRO' } = {}) {
  if (!v) return null;
  const link = (id) => { const m = /^osm:(node|way)\/(\d+)$/.exec(id); return m ? `https://www.openstreetmap.org/${m[1]}/${m[2]}` : null; };
  const labels = v.categoryLabels ?? {};
  const where = v.center?.label ? v.center.label : 'the meetup point';
  const fetched = v.fetchedAt ? new Date(v.fetchedAt).toLocaleString() : null;
  const banner = v.provenance === 'live' ? null
    : v.provenance === 'cached' ? `Cached live data${fetched ? ` from ${fetched}` : ''} — it may be slightly out of date.`
    : `Live place data is unavailable right now — showing a saved OpenStreetMap snapshot${v.snapshotDate ? ` dated ${v.snapshotDate}` : ''}. Places may have changed; check before you go.`;
  const counts = Object.entries(v.counts ?? {}).map(([k, n]) => `${labels[k]?.emoji ?? ''} ${labels[k]?.label ?? k}: ${n}`).join(' · ');
  return h('section', { class: 'card' }, h('h2', {}, `Places within ${v.radiusKm} km of ${where}`),
    banner ? h('p', { class: 'banner warn', role: 'status' }, banner) : h('p', { class: 'hint' }, `Live OpenStreetMap data${fetched ? ` · fetched ${fetched}` : ''}.`),
    v.warnings?.includes('SNAPSHOT_DATA_INCLUDED') && v.provenance !== 'snapshot' ? h('p', { class: 'hint' }, 'Some entries come from the saved snapshot (marked below) because they are not in the live results.') : null,
    v.cachedFromDatabase ? h('p', { class: 'hint' }, `Stored for this plan ${v.storedAt ? new Date(v.storedAt).toLocaleString() : ''} — use “Search again” for fresh results.`) : null,
    !v.venues.length ? h('p', {}, 'No places found within this radius. Try a wider radius or another category.') : [
      counts ? h('p', { class: 'hint' }, counts) : null,
      h('ul', { class: 'venues' }, v.venues.map(x => h('li', {},
        h('strong', {}, `${labels[x.category]?.emoji ?? '📍'} ${x.name}`), ' ', badge(labels[x.category]?.label ?? x.category), ' ', badge(PROVENANCE[x.provenance]?.[0] ?? x.provenance, PROVENANCE[x.provenance]?.[1] ?? ''),
        h('div', { class: 'hint' }, `${x.distanceKm != null ? fmt(x.distanceKm, 2) + ' km from ' + where : ''}${x.rating != null ? ` · rating ${x.rating} (${x.ratingSource})` : ''}${x.openingHours ? ` · hours: ${x.openingHours}` : ''}`),
        mode === 'BIKE' && x.lat != null && x.lon != null ? h('button', { type: 'button', class: 'link', 'aria-label': `Show ${x.name} on the route map`, onclick: () => document.dispatchEvent(new document.defaultView.CustomEvent('mm:venue', { detail: { lat: x.lat, lon: x.lon, name: x.name } })) }, 'Show on map') : null, ' ',
        link(x.id) ? h('a', { href: link(x.id), rel: 'noopener noreferrer', target: '_blank' }, 'View on OpenStreetMap') : null)))],
    v.warnings?.includes('FEW_RESULTS') ? h('p', { class: 'hint' }, 'Only a few places are in range — try a wider radius.') : null,
    h('p', { class: 'hint' }, v.attribution));
}

// Bike map: shows the venue picked in the places list (a custom event from renderVenues). Stops listening once the plan leaves the page.
function mapBox(canvas, mode, redraw, remember) {
  const box = h('div', { class: 'mapbox' }, canvas);
  if (mode !== 'BIKE') return box;
  const on = (e) => {
    if (!box.isConnected) { document.removeEventListener('mm:venue', on); return; }
    remember(e.detail); const next = redraw(); if (next) box.replaceChildren(next);
  };
  document.addEventListener('mm:venue', on);
  return box;
}
