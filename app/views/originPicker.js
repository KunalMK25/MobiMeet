import { h, field, announce } from '../dom.js';
import { get } from '../api.js';
import { parseCoordinate, stationOrigin, describeOrigin } from '../origin.js';

// Reusable starting-point picker. Methods: station (Metro only), address search, "use my location" (user-initiated),
// saved places, manual coordinates. Returns {el, getOrigin, setOrigin}. Exact coordinates stay on this device until submit.
export function createOriginPicker({ mode, stations = [], savedPlaces = [], initial = null, idPrefix = 'op' }) {
  let current = initial ? { origin: initial } : null;
  const selected = h('p', { class: 'selected', 'aria-live': 'polite' });
  const msg = h('p', { class: 'error', role: 'alert' });
  const refresh = () => { selected.textContent = `Starting point: ${current ? describeOrigin(current.origin) : 'not set'}`; };
  const set = (r, announceText) => { if (r.error) { msg.textContent = r.error; return; } msg.textContent = ''; current = r; refresh(); announce(announceText ?? `Starting point set to ${describeOrigin(r.origin)}`); };
  refresh();

  const parts = [];
  if (mode === 'METRO') {
    const list = h('datalist', { id: `${idPrefix}-stations` }, stations.map(s => h('option', { value: s.name }, `${s.line} line`)));
    const input = h('input', { type: 'text', list: list.id, autocomplete: 'off', placeholder: 'Start typing a station…' });
    input.addEventListener('change', () => { if (input.value.trim()) set(stationOrigin(stations, input.value)); });
    parts.push(field('Metro station', input, 'Pick the station you will start from.').row, list);
  }

  const q = h('input', { type: 'search', placeholder: 'e.g. Indiranagar 100 Feet Road', autocomplete: 'off', maxlength: '120' });
  const results = h('ul', { class: 'results', 'aria-label': 'Address search results' });
  const searchBtn = h('button', { type: 'button', class: 'secondary', onclick: async () => {
    msg.textContent = ''; results.replaceChildren();
    if (q.value.trim().length < 3) { msg.textContent = 'Type at least 3 characters.'; return; }
    searchBtn.disabled = true;
    try {
      const r = await get(`/api/geocode?q=${encodeURIComponent(q.value.trim())}`);
      if (!r.results.length) results.append(h('li', {}, 'No matches in Bengaluru.'));
      for (const x of r.results) results.append(h('li', {}, h('button', { type: 'button', class: 'link', onclick: () => { set({ origin: { lat: x.lat, lon: x.lon, label: x.label.slice(0, 100) } }); results.replaceChildren(); } }, x.label)));
      results.append(h('li', { class: 'hint' }, r.attribution));
    } catch (e) { msg.textContent = e.message; } finally { searchBtn.disabled = false; }
  } }, 'Search');
  parts.push(h('fieldset', {}, h('legend', {}, mode === 'METRO' ? 'Or start from an address / place' : 'Starting address / place'), field('Address search', q, 'Results come from OpenStreetMap, limited to Bengaluru. Only your search text is sent.').row, searchBtn, results));

  if (navigator.geolocation) {
    parts.push(h('button', { type: 'button', class: 'secondary', onclick: () => {
      msg.textContent = '';
      navigator.geolocation.getCurrentPosition(
        (p) => { const r = parseCoordinate(p.coords.latitude, p.coords.longitude); set(r.origin ? { origin: { ...r.origin, label: 'My current location' } } : r); },
        () => { msg.textContent = 'Location access was denied or unavailable.'; }, { timeout: 8000, maximumAge: 60000 });
    } }, 'Use my current location'));
  }
  if (savedPlaces.length) {
    const sel = h('select', {}, h('option', { value: '' }, 'Choose…'), savedPlaces.map((p, i) => h('option', { value: String(i) }, p.label)));
    sel.addEventListener('change', () => { const p = savedPlaces[Number(sel.value)]; if (p) set({ origin: { lat: p.lat, lon: p.lon, label: p.label } }); });
    parts.push(field('Saved place', sel).row);
  }
  const lat = h('input', { type: 'text', inputmode: 'decimal', placeholder: '12.9716' }), lon = h('input', { type: 'text', inputmode: 'decimal', placeholder: '77.5946' });
  parts.push(h('details', {}, h('summary', {}, 'Enter coordinates manually'), field('Latitude', lat).row, field('Longitude', lon).row,
    h('button', { type: 'button', class: 'secondary', onclick: () => set(parseCoordinate(lat.value, lon.value)) }, 'Use these coordinates')));

  const el = h('div', { class: 'origin-picker' }, selected, msg, parts);
  return { el, getOrigin: () => current?.origin ?? null, setOrigin: (o) => { current = o ? { origin: o } : null; refresh(); } };
}
