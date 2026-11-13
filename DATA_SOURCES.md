# DATA_SOURCES.md

Last reviewed: 2026-11-13. **Nothing is marked "official"**: the BMRCL site was reachable (english.bmrc.co.in) but exposed no machine-readable station or status data, so network facts come from published secondary sources and must be re-checked against BMRCL before being presented as verified. The in-code provenance (`data/network.js`) says `verification: 'secondary'` and a test forbids `official` until that changes.

## Metro
| Data | Source | Verification | Notes |
|---|---|---|---|
| Purple (37), Green (32), Yellow (16) station order | [List of Namma Metro stations](https://en.wikipedia.org/wiki/List_of_Namma_Metro_stations) | secondary | Corrected Green order (Sampige Road, Banashankari/JP Nagar); added Vajarahalli → 83 stations, matching the published count |
| Pink Line: 18 stations, 6 elevated + 12 underground | [Pink Line (Namma Metro)](https://en.wikipedia.org/wiki/Pink_Line_(Namma_Metro)) | secondary | |
| Pink elevated opening | news reports: CMRS clearance 28 Oct 2026, inauguration 13 Nov, public service from 14 Nov 06:00 IST (one source says 15 Nov) | secondary, **conflicting** | project owner instructs: Phase 1 operational as of 13 Nov 2026; `openFrom` = 2026-11-13T00:00+05:30 in `data/network.js` (news says public service 14 Nov 06:00) — verify with BMRCL |
| Pink underground (Dairy Circle → Nagawara) | same sources: Mar–May 2027 estimates | secondary | status `under_construction`; excluded from routing; Jayadeva Hospital is an interchange only while the Pink section is active |
| Pink terminus name | "Tavarekere" (news) vs "S.G. Palya / Suddagunte Palya" (Wikipedia) | unresolved | modelled as one station with an alias |
| Station coordinates (original) | original planner baseline | **not re-verified** | e.g. Jayadeva Hospital looks offset vs OSM |
| Pink + Vajarahalli coordinates | OSM Nominatim area-level / interpolated between neighbours | **approximate** | flagged `approx` in `data/stations.js` |
| Fares | BMRCL 2024 slabs by stop count (baseline) | **estimate** | real fares are distance-based |
| Travel time | 2 min per hop + per-station transfer allowance | **estimate** | no live train data |

## Map, routing, venues, geocoding
| Service | Use | Terms handled |
|---|---|---|
| OpenStreetMap data (ODbL) | venues, geocoding, road network | attribution shown in API results and UI |
| OSRM (default: public demo `router.project-osrm.org`, car profile) | Bike distances, durations, geometry | **development only**; ≤1 request/s spacing, cache, identifying User-Agent; configurable via `ROUTING_PROVIDER_URL`; free-flow durations, **not traffic-aware** and labelled so |
| Overpass API (`overpass-api.de`, configurable) | nearby venues | 1 retry on 429/5xx, 1 h cache; ratings do not exist in OSM and are never invented; opening hours shown only as the raw OSM tag |
| Nominatim | address search + reverse lookup of the single recommended Bike point | server-side proxy, ≥1.1 s spacing, 24 h cache, Bengaluru-bounded, authenticated + rate-limited |
| Curated sample places (`data/places-db.js`) | fallback only | exact station match only; always labelled sample data |
| Fuel price / mileage | **user-supplied** | never defaulted; the source and date the user enters are displayed |

## Open verification items (kept from earlier audits)
* **BMRCL verification is outstanding.** The BMRCL site was reachable but exposes no machine-readable station or status data and no official notice was found, so every network fact is labelled `secondary` and a test prevents labelling any of it `official`. Needs a human check of station order, interchanges, Pink Line status/dates, and fares (BMRCL slabs are distance-based; the app uses a stop-count estimate).
* Approximate coordinates: Pink Line stations and Vajarahalli; existing coordinates such as Jayadeva Hospital are unverified.
* **Venues:** the bundled OpenStreetMap snapshot (137 confirmed places) covers 70 of 88 stations; gaps are filled by live Overpass data when reachable. Public Overpass servers were unreachable during testing, so live lookups are unverified (the snapshot fallback is verified and labelled "snapshot"). Places that could not be matched in OpenStreetMap — for example several large malls — were dropped rather than guessed.
