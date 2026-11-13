# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses its own `appVersion` (see `src/config/Version.js`)
rather than strict SemVer, since it's an application, not a published
package.

## [Unreleased] — MobiMeet (7.0.0-dev)
### Added
- Multi-user MobiMeet app (`/app/`) with accounts, profiles, groups, secure invitations, participant agents and a coordinator.
- Transport-agnostic fairness optimiser (Jain index, five strategies, hard limits) with Metro and Bike engines; Bike uses an OSRM-compatible provider, bounded candidate refinement, route geometry and opt-in fuel estimates.
- Versioned plans, confirmation without overwrite, what-if scenarios, venue discovery, plan-grounded chat, optional server-side LLM features with verified output.
- Status-driven metro network; **Pink Line Phase 1 (Kalena Agrahara → Tavarekere) operational from 13 Nov 2026** (your instruction; news reports differ by a day — see `DATA_SOURCES.md`), Phase 2 underground excluded until its status is changed in `src/data/network.js`; stable station IDs.
- Product renamed **MobiMeet** in all user-facing text (technical names such as package, repo and storage keys unchanged).
- Nearby-venue layer: configurable radius (`VENUE_RADIUS_KM`, per-search selector), many categories incl. clubs/entertainment, distance from the meetup station, de-duplication, overlapping catchments, provenance label (live / cached / bundled snapshot / sample). Bundled OSM-confirmed catalogue of 137 venues (243 candidate places searched; 94 could not be confirmed against OpenStreetMap and were dropped, never guessed — rebuild with `scripts/build-venue-catalogue.mjs`).
- Accounts: redesigned sign-up/sign-in with inline validation, show/hide password, strength guidance, forgot/reset password (single-use 30-min token; development outbox only until a mail provider is configured, `MAIL_MODE`), profile editing, change password, sign out everywhere, account deletion.
- Post-login travel-mode screen (Metro / Bike) and separate Metro and Bike planners; a group's mode is fixed at creation and enforced in the UI, API and database.
- PostgreSQL schema/migrations, DB-backed rate limiting, retention and account deletion; Vercel API function, cron and CSP.
- Offline app shell and on-device saved plans; accessibility checks.
- Per-person Metro route strategies; schematic Metro map in the new app; production routing-provider guard and options document; ESLint + CI workflow.
- 273 automated tests (unit, integration over HTTP, security, jsdom UI) and a verifier covering all first-party code.
- **Personal agents (spec §10):** named participant seats with single-claim identity selection; one lightweight agent per participant; private agent conversations; shared append-only event layer with per-agent delivery/ack; delay/arrival/withdrawal/location/plan-response updates; per-participant sharing controls; coordinator recommendations that never change a confirmed plan; status dashboard and activity feed UI. Migration `003_participants_agents_events`.
- Production-readiness: group size is any number from 2 to 12 (`src/config/Limits.js`) — agents, invitations and optimisation work for every size; model-call budgets (requests and tokens; per user, group, minute and day; env-configurable; shared through the database) plus back-off after a provider 429; Resend email adapter (off unless configured); strict TLS (`verify-full`) and serverless pool settings for PostgreSQL; `npm run test:pg` runs the suite against a real PostgreSQL database (migration `003_participants_agents_events`).
### Fixed
- Green Line station order (Sampige Road, Banashankari/JP Nagar) and missing Vajarahalli.
- HTML injection risks in the classic planner (names, OSM place names, chat); an inline `onclick` built from place data.
- Removed the browser-side LLM call from the classic planner (keys must never reach the browser).
### Notes
- No ML model is shipped (no legitimate dataset); see `ARCHITECTURE.md`.

## [6.0.0] — Modular architecture & production readiness

### Added
- Full migration from a single-file monolith to a modular ES module
  architecture (`data/ → core/ → places/ → rendering/ → ai/ → ui/ → main.js`)
  with zero behavioral changes.
- **Diagnostics framework**: 29 automated tests across Graph, Routing,
  Optimization, Places, Renderer, and AI suites — DEBUG-gated, isolated from
  production paths.
- **Performance layer**: `PerformanceMonitor` (timing + cache hit/miss +
  memory usage), a DEBUG-gated developer overlay, and `exportDebugReport()`.
- **Feature flags**: `AI_ASSISTANT`, `LIVE_PLACES`, `RENDER_CACHE`,
  `DIAGNOSTICS`, `PERFORMANCE_OVERLAY` — every subsystem reads from these
  instead of hardcoded booleans.
- **Error boundaries** for Places provider failures, AI request failures,
  canvas rendering exceptions, and missing station/route/asset lookups.
- **Rendering performance rewrite**: requestAnimationFrame-coalesced redraw
  scheduler, cached offscreen static bitmap (regenerated only on real
  viewport changes), and a zoom/size-keyed label-collision-layout cache.
- **Context-aware AI assistant**: a structured `buildAppContext()` snapshot,
  a data-grounded direct-answer layer, and a real Claude API integration
  with automatic offline fallback.
- **Modular Places provider architecture**: `StaticPlacesProvider`,
  `OSMPlacesProvider` (live Overpass API), and a `GooglePlacesProvider` stub,
  behind one shared interface with automatic fallback and per-station caching.
- **Schematic (BMRCL-style) map renderer** replacing the earlier
  geography-accurate map — even stop-spacing, proper line branching (Yellow
  Line branches from Green at RV Road), collision-avoiding labels.
- **Searchable station autocomplete** (keyboard + mouse navigable) replacing
  the original `<select>` dropdown.
- Comprehensive JSDoc across every major module; a full architecture summary
  and release checklist at the top of the (then-monolithic) source.

### Changed
- Meetup recommendation scoring extended to include a **Station
  Attractiveness Score** (nearby cafes/restaurants/malls/parks/arcades/bars,
  within ~5km) as a tie-breaker, behind travel fairness and interchange count.

### Fixed
- **Interchange detection bug**: routes that stayed on a single line through
  a physical interchange station (e.g. Green Line via RV Road) were
  incorrectly charged an interchange penalty. Fixed by deriving interchanges
  from the actual line-aware graph traversal instead of a station-name flag —
  regression-tested in the Diagnostics Routing suite.
- Dropped station-spacing checkpoints that crammed 12 real stations into the
  shortest schematic segment on the map while giving a 1-station segment the
  most space — rebalanced to even per-stop spacing.
- A dropped `const canvas = ...` declaration during the renderer migration
  (caught immediately via a full functional boot test, not just a syntax
  check).

## [5.x] — Feature build-out (pre-modularization)

- Weighted graph + Dijkstra routing engine (replacing an earlier array-based
  line model).
- Fairness-first meetup optimization algorithm.
- Full route reconstruction (station-by-station path, fare, interchange
  detection) per friend.
- Initial nearby-places drawer (static curated dataset).
- Offline rule-based chatbot (routes, fares, interchanges, timings).

## [1.0.0] — Initial release

- Single-file HTML/CSS/JS application.
- Static station/line data for Purple, Green, and Yellow lines.
- Basic meetup-point suggestion.
