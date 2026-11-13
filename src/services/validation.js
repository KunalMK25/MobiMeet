// Strict, whitelisting input validation. Unknown fields are dropped; every value is
// type- and range-checked. Free-form text is length-limited and never interpreted.
import { DomainError, ErrorCode, fail } from '../domain/errors.js';
import { assertTransportMode } from '../domain/transport.js';
import { STRATEGIES } from '../optimizer/strategies.js';
import { stationKeyFor } from '../data/station-ids.js';
import { ST } from '../data/stations.js';
import { passwordProblems } from '../utils/passwordPolicy.js';

export const isUuid = (s) => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
export const requireUuid = (s, what = 'id') => { if (!isUuid(s)) fail(ErrorCode.NOT_FOUND, `${what} not found.`); return s.toLowerCase(); };

export function validateEmail(e) {
  const v = typeof e === 'string' ? e.trim().toLowerCase() : '';
  if (v.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) fail(ErrorCode.INVALID_INPUT, 'A valid email is required.');
  return v;
}
export function validatePassword(p, context = {}) {
  const problems = passwordProblems(p, context);
  if (problems.length) fail(ErrorCode.INVALID_INPUT, problems[0]);
  return p;
}
export function validateText(s, { min = 1, max = 80, what = 'Text' } = {}) {
  const v = typeof s === 'string' ? s.trim().replace(/\s+/g, ' ') : '';
  if (v.length < min || v.length > max) fail(ErrorCode.INVALID_INPUT, `${what} must be ${min}-${max} characters.`);
  return v;
}
export const optionalText = (s, max, what) => (s === undefined || s === null || s === '' ? '' : validateText(s, { min: 0, max, what }));

export function validateStrategy(s) {
  if (s === undefined) return 'balanced';
  if (!STRATEGIES.includes(s)) fail(ErrorCode.INVALID_INPUT, 'Unknown strategy.');
  return s;
}
export const ROUTE_STRATEGY_NAMES = ['fastest', 'fewest_transfers', 'lowest_fare'];
export function validateRouteStrategy(s) {
  if (s === undefined || s === null) return 'fastest';
  if (!ROUTE_STRATEGY_NAMES.includes(s)) fail(ErrorCode.INVALID_INPUT, 'Unknown route strategy.');
  return s;
}
export function validateMode(m) { return assertTransportMode(m); }

// Origin: either a metro station (stationId) or a coordinate. Returns normalised parts.
export function validateOriginInput(o, { mode }) {
  if (!o || typeof o !== 'object') fail(ErrorCode.MISSING_ORIGIN, 'An origin is required.');
  const label = o.label === undefined ? null : validateText(o.label, { min: 0, max: 120, what: 'Origin label' }) || null;
  if (o.stationId !== undefined) {
    if (mode !== 'METRO') fail(ErrorCode.INVALID_INPUT, 'stationId origins are only valid for Metro groups.');
    const key = stationKeyFor(o.stationId);
    if (!key) fail(ErrorCode.INVALID_INPUT, 'Unknown station.');
    if (!ST[key]?.op) fail(ErrorCode.INVALID_INPUT, 'That station is not currently operational.');
    return { stationId: o.stationId, lat: ST[key].la, lon: ST[key].lo, label: label ?? key };
  }
  const { lat, lon } = o;
  if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    fail(ErrorCode.MISSING_ORIGIN, 'A valid origin (lat/lon or station) is required.');
  }
  return { lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6, label };
}

const unit = (v, name) => {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !(v >= 0 && v <= 1)) fail(ErrorCode.INVALID_INPUT, `${name} must be between 0 and 1.`);
  return v;
};
const pos = (v, name, max) => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > max) fail(ErrorCode.INVALID_INPUT, `${name} must be a positive number up to ${max}.`);
  return v;
};
const bool = (v) => (v === true ? true : undefined);

export function validatePrefs(raw = {}) {
  if (raw === null || typeof raw !== 'object') fail(ErrorCode.INVALID_INPUT, 'Preferences must be an object.');
  const out = { costSensitivity: unit(raw.costSensitivity, 'costSensitivity'), timeSensitivity: unit(raw.timeSensitivity, 'timeSensitivity'), avoidInterchanges: bool(raw.avoidInterchanges), minimizeFuelCost: bool(raw.minimizeFuelCost) };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}
export function validateHard(raw = {}) {
  if (raw === null || typeof raw !== 'object') fail(ErrorCode.INVALID_INPUT, 'Constraints must be an object.');
  const out = { maxTravelMinutes: pos(raw.maxTravelMinutes, 'maxTravelMinutes', 600), maxDistanceKm: pos(raw.maxDistanceKm, 'maxDistanceKm', 500), requiresStepFreeAccess: bool(raw.requiresStepFreeAccess) };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}
export function validateFuel(raw) {
  if (raw === undefined || raw === null) return null;
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1e5 ? v : null);
  const mileage = n(raw.mileageKmPerLitre), price = n(raw.fuelPricePerLitre);
  if (mileage == null || price == null) fail(ErrorCode.INVALID_INPUT, 'Fuel assumptions need a positive mileage and fuel price.');
  return { mileageKmPerLitre: mileage, fuelPricePerLitre: price, priceSource: validateText(raw.priceSource ?? 'user-supplied', { max: 80, what: 'priceSource' }), priceDate: raw.priceDate == null ? null : validateText(raw.priceDate, { max: 10, what: 'priceDate' }) };
}
export { DomainError };
