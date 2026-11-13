import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptResult, typeAccepted, nameMatches, inBengaluru } from '../src/venues/catalogueBuild.js';

const R = (o) => ({ osm_type: 'node', osm_id: 7, lat: '12.9345', lon: '77.6113', category: 'shop', type: 'mall', name: 'Nexus Koramangala', display_name: 'Nexus Koramangala, Koramangala, Bengaluru', ...o });
const seed = { q: 'Nexus Mall Koramangala, Bengaluru', cat: 'mall' };

test('a matching, correctly-typed, in-city result is accepted with provenance fields', () => {
  const v = acceptResult(seed, R({}), '2026-11-13');
  assert.deepEqual(v, { id: 'osm:node/7', name: 'Nexus Koramangala', category: 'mall', lat: 12.9345, lon: 77.6113, osmClass: 'shop', osmType: 'mall', retrievedAt: '2026-11-13' });
});
test('rejected: outside Bengaluru, wrong kind of place, or a different place with a similar address', () => {
  assert.equal(acceptResult(seed, R({ lat: '28.6', lon: '77.2' }), 'd'), null);                                // Delhi
  assert.equal(acceptResult(seed, R({ category: 'amenity', type: 'dentist' }), 'd'), null);                    // not a mall
  assert.equal(acceptResult(seed, R({ name: 'City Hospital', display_name: 'City Hospital, Koramangala, Bengaluru' }), 'd'), null);   // matches only the area word
  assert.equal(acceptResult({ q: 'Toit, Indiranagar', cat: 'bar' }, R({ category: 'amenity', type: 'pub', name: 'Toit Brewpub', display_name: 'Toit Brewpub, Indiranagar' }), 'd').category, 'bar');
});
test('type rules per category, name matching ignores filler words', () => {
  assert.ok(!typeAccepted('attraction', 'tourism', 'hotel'), 'a hotel is not a sight');
  assert.ok(typeAccepted('club', 'amenity', 'nightclub')); assert.ok(typeAccepted('park', 'leisure', 'park')); assert.ok(typeAccepted('attraction', 'tourism', 'museum')); assert.ok(typeAccepted('attraction', 'historic', 'castle'));
  assert.ok(!typeAccepted('mall', 'shop', 'supermarket'), 'a supermarket is not a mall');
  assert.ok(!typeAccepted('attraction', 'highway', 'secondary'), 'a road is not a sight…');
  assert.ok(typeAccepted('attraction', 'highway', 'pedestrian', { street: true }) && !typeAccepted('mall', 'highway', 'pedestrian', { street: true }), '…unless the seed is explicitly a street');
  assert.equal(acceptResult({ q: 'Bull Temple, Basavanagudi', cat: 'attraction' }, R({ category: 'highway', type: 'secondary', name: 'Bull Temple Road', display_name: 'Bull Temple Road' }), 'd'), null);   // regression: road ≠ temple
  assert.equal(acceptResult({ q: 'Lulu Mall, Rajajinagar', cat: 'mall' }, R({ type: 'supermarket', name: 'Lulu Daily', display_name: 'Lulu Daily' }), 'd'), null);                                    // regression: supermarket ≠ mall
  assert.ok(!typeAccepted('club', 'shop', 'mall')); assert.ok(!typeAccepted('mall', 'amenity', 'restaurant')); assert.ok(!typeAccepted('nope', 'amenity', 'cafe'));
  assert.ok(nameMatches('Mavalli Tiffin Rooms Lalbagh Road, Bengaluru', { name: 'Mavalli Tiffin Rooms', display_name: 'Mavalli Tiffin Rooms, Lalbagh Road' }));
  assert.ok(!nameMatches('Koshy\'s Parade Cafe', { name: 'Parade Ground', display_name: 'Parade Ground' }));      // one shared word out of two is not enough
  assert.ok(nameMatches('Koshy\'s Parade Cafe', { name: 'Koshy\'s', display_name: 'Koshy\'s, St. Marks Road' }) === false);   // 1 of 2 (the second word is missing)
  assert.ok(!nameMatches('Lalbagh Botanical Garden', { name: 'Atal Bihari Botanical Garden', display_name: 'Atal Bihari Botanical Garden' }));   // regression: a DIFFERENT garden sharing 2 of 3 words
  assert.ok(nameMatches('Mavalli Tiffin Rooms Lalbagh Road', { name: 'Mavalli Tiffin Rooms', display_name: 'Mavalli Tiffin Rooms' }));                // 3 of 4 distinctive words is enough for a long name
  assert.ok(nameMatches('Toit, Indiranagar', { name: 'Toit Brewpub', display_name: 'Toit Brewpub' }));              // a single distinctive word must be present
  assert.ok(!nameMatches('Skyye Lounge UB City', { name: 'Lounge Bar', display_name: 'Lounge Bar' }));
  assert.ok(inBengaluru(12.97, 77.59) && !inBengaluru(13.5, 77.59));
});
