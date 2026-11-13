# 🚇🏍️ MobiMeet

**Personalised group meetup planning for Bengaluru — by Metro or by bike.**
Everyone starts somewhere different. MobiMeet finds the meetup location where **nobody has to travel unfairly far**, shows each person's route, time and cost, explains *why* it chose that spot, and lets the group compare alternatives and "what-if" scenarios before confirming.

It grew out of the original single-device Metro planner (still available at `/` as the **Quick Metro planner**, unchanged in behaviour) into a multi-user application: accounts, secure invitations, two transport modes, road-network routing, a deterministic fairness optimiser, venue discovery and optional LLM assistance that is never allowed to touch the numbers.

## What it does
* **Groups & invitations** — create a group, choose **Metro** *or* **Bike** (one mode per group, enforced by the API *and* the database, locked after creation), share an expiring, revocable, single-view invitation link. Each person sets their own starting point and preferences for that group.
* **Metro** — line-aware Dijkstra with per-person route strategies (fastest / fewest changes / lowest fare) and a schematic route map over the Namma Metro network (Purple, Green, Yellow, and the **Pink Line** elevated section, which switches on automatically on its opening date; underground sections stay excluded until opened). Walking to the nearest *several* stations is considered, not just the nearest one.
* **Bike** — real road distances/times from an OSRM-compatible provider (configurable), geographic candidates refined once around the best, route geometry, and a fuel-cost estimate **only if you supply mileage and price** (never invented).
* **Fairness-first optimisation** — minimises the worst individual journey first; reports range, standard deviation and Jain's fairness index; five strategies (balanced, fastest, cheapest, fewest transfers, balanced time/cost); hard limits per person; reproducible results.
* **Explainability** — decision explanations generated from the optimiser's own numbers, plus limitations (e.g. "times are estimates, not live traffic").
* **Venues** — places near the meetup point from OpenStreetMap; labelled sample data if live data is unavailable. Nothing is invented.
* **What-if** — add/remove people, move a start point, change strategy; scenarios are stored separately and never touch the group or a confirmed plan. Plans are versioned; confirming a new plan supersedes (never overwrites) the old one.
* **Optional AI** (server-side keys; Groq, Anthropic or OpenAI): re-word explanations (numbers verified against the facts), suggest preferences from a note (validated, never auto-applied), answer questions about the plan. Everything works without a key.
* **Offline** — app shell and the classic planner work offline; the last viewed plan is kept on the device with a staleness warning.
* **Accessible & responsive** — labelled controls, keyboard focus styles, no colour-only status, mobile layout.

### Personal agents (no group chat)
Each participant has their **own** lightweight agent. You tell *your* agent things like “I’m running 15 minutes late”; it records the fact, decides what the group needs to know (never your words), and publishes a structured update to a shared event log that the other participants’ agents read. Ask your agent “What happened to Asha?” and it answers from what Asha chose to share. The plan creator names the participants; one invitation link serves everyone and each person claims their own name once. See `ARCHITECTURE.md`.

## Quick start
```bash
npm install
npm run dev:full      # → http://localhost:3000/app/     (classic planner: http://localhost:3000/)
npm run env:check     # what is set / missing (names only — never prints secrets, makes no network calls)
npm run check         # ESLint + static verification + 200 unit / integration / UI tests
npm run build         # → dist/ (static site; the API deploys as a Vercel function)
```
No accounts or keys are needed locally: the dev server uses an embedded PostgreSQL (PGlite). Optional environment variables are listed in [`.env.example`](.env.example).

## Documentation
| | |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | components, layering, data model, security & privacy model |
| [`API_DOCUMENTATION.md`](API_DOCUMENTATION.md) | every endpoint, error codes, result shapes |
| [`DEPLOYMENT.md`](DEPLOYMENT.md) | local setup, environment variables, Neon database, routing and email options, AI cost controls, Vercel preview steps |
| [`DATA_SOURCES.md`](DATA_SOURCES.md) | metro, map, routing and venue sources, verification status |
| [`MobiMeet_AI_Build_Spec_v2.0.md`](MobiMeet_AI_Build_Spec_v2.0.md) | the product/engineering specification |
| `docs/*.md` | original planner design docs (algorithms, renderer, places, diagnostics, performance) |

## Honest limitations and next steps
* Times and fares are **estimates** (flat minutes per hop, stop-count fare slabs, free-flow road times — no live trains or traffic). Metro network facts come from published secondary sources and are **not yet verified against BMRCL**; the Pink Line Phase 1 opening date (13 Nov 2026 per the project owner; news reports say public service from 14 Nov) and the Tavarekere / S.G. Palya naming are unresolved; some coordinates are approximate. Step-free access is recorded but cannot be applied (no data). No ML model is trained (no legitimate dataset).
* Station records are still keyed by display name internally (stable IDs exist at every boundary); the offline chatbot text and static HTML still describe only some lines; per-segment travel times and distance-based fares are not implemented.
* Bike routing: the public OSRM demo is development-only and uses a **car** profile; production needs `ROUTING_MODE=estimate` or your own routing server (see `DEPLOYMENT.md`). Live venue lookups depend on public Overpass servers; a saved OpenStreetMap snapshot (covers 70 of 88 stations) is used and labelled when they are unreachable.
* Updates between agents arrive by polling (about every 15 seconds while a page is open) — no push or email notifications. A forwarded invitation link can be used by the wrong person to claim an *unclaimed* name; the plan creator sees which account holds each seat and can release it. Plans show each member's route to the meetup, which implies their start area (the join screen says so).
* Next steps: verify Metro data with BMRCL; segment times and distance-based fares; stable IDs as internal graph keys; a production routing provider; a click-to-pick map for Bike; Playwright end-to-end tests and a type-check pipeline; an evaluated ML model only if real, consented trip data exists (obtain data with documented provenance and licence → define target and leakage checks → beat the deterministic baseline on held-out data → record a model card → register it).

## License
[MIT](LICENSE). Map data © OpenStreetMap contributors (ODbL).
