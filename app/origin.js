// Pure origin-input model (unit-tested): turns UI state into the API's origin object or an error message.
export function parseCoordinate(latText, lonText) {
  const lat = Number(String(latText).trim()), lon = Number(String(lonText).trim());
  if (String(latText).trim() === '' || String(lonText).trim() === '' || !Number.isFinite(lat) || !Number.isFinite(lon)) return { error: 'Enter numeric latitude and longitude.' };
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return { error: 'Latitude must be within ±90 and longitude within ±180.' };
  if (lat < 12.7 || lat > 13.3 || lon < 77.3 || lon > 77.95) return { error: 'That point is outside the Bengaluru area this planner covers.' };
  return { origin: { lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6 } };
}
export function stationOrigin(stations, nameOrId) {
  const q = String(nameOrId).trim().toLowerCase();
  const s = stations.find(x => x.id === q || x.name.toLowerCase() === q);
  return s ? { origin: { stationId: s.id, label: s.name } } : { error: 'Choose a station from the list.' };
}
export const describeOrigin = (o) => (!o ? 'Not set' : o.label ? o.label : o.stationId ? o.stationId : `${o.lat?.toFixed?.(4)}, ${o.lon?.toFixed?.(4)}`);
