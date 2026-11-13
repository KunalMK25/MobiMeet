# Architecture

MobiMeet grew out of the original single-device Metro planner without replacing it: the original single-device planner (`/`, `src/main.js`) is untouched in behaviour, and a new authenticated multi-user app (`/app/`) plus a serverless API sit on the same domain and share the same routing and optimisation code.

```
Browser                                    Server (Vercel function api/index.js  |  scripts/dev-server.mjs)
┌───────────────────────────┐             ┌───────────────────────────────────────────────────────────┐
│ /        classic planner  │             │ api/http.js   pipeline: size → CSRF/origin → session → route │
│ /app/    MobiMeet web app │──fetch /api─▶ api/routes.js thin handlers (no business logic)            │
│  app/*.js (no innerHTML)  │             │ services/     auth · groups · plans · what-if · retention   │
│  sw.js    offline shell   │             │ agents/       participant agent · coordinator               │
└───────────────────────────┘             │ optimizer/    fairness · strategies · metro engine          │
                                           │ bike/         OSRM provider · candidates · fuel · optimiser │
 shared, deterministic, pure:              │ venues/ geo/  Overpass · Nominatim (server-side proxies)    │
 data/ core/ domain/ optimizer/ bike/      │ ai/           LLM provider · phraser · parser · chat (opt.) │
                                           │ db/           migrations · client (pg | PGlite)             │
                                           └───────────────────────────────┬───────────────────────────┘
                                                                           ▼ PostgreSQL (personal DB)
```

## Layers and rules
* **Dependency direction** (verified by `npm run verify`, which also checks syntax, import resolution, cycles and case-colliding filenames across `src/ app/ api/ scripts/ tests/`): `data → core → domain → optimizer/bike → agents → services → api`. The browser bundle (`app/`) imports nothing server-side (tested).
* **Deterministic core.** Routing (Dijkstra), fares, fairness arithmetic, ranking and explanations are pure functions. **No LLM, clock or network is used in the optimiser**; time is injected (`now`) so results are reproducible. The LLM can only (a) re-word an explanation — rejected if it introduces any number not in the facts —, (b) suggest preference values that pass the same validators as user input, (c) answer open chat questions from plan facts with unverified numbers flagged.
* **One optimiser, two engines.** `optimizer/groupOptimizer.js` takes candidates + an `evaluate(participant, candidate)` function. `metroEngine.js` (access-station search + line-aware Dijkstra) and `bike/bikeOptimizer.js` (road-network matrix, bounded refinement) only supply journeys, so the same feasibility, hard-constraint, metrics, strategy and tie-break logic applies to both.

## Metro network
`data/network.js` is the single definition of lines: full station order per line, divided into **sections** with `status` (`open | under_construction | planned`), optional `openFrom`, and provenance (`source`, `verifiedOn`, `verification`). The routing graph is built from **active** sections only (`core/graph.js`), the schematic map, station lists, `op` flags and interchange labels all derive from it. Opening the Pink Line's underground section is therefore a one-line data change. Stable IDs live in `data/station-ids.js` and are used at every external boundary (API, DB, invitations); internal graph keys remain station names (a documented limitation).

## Routing providers (Bike) and route strategies (Metro)
`bike/routingFactory.js` picks the provider from configuration; the public OSRM demo is refused in production-like deployments and a disabled provider makes Bike optimisation fail loudly, whereas a transient outage of a configured provider degrades to a labelled straight-line fallback. Options, limits and costs: `DEPLOYMENT.md` (Bike routing). For Metro, `optimizer/metroEngine.js` chooses each person's path with a strategy-specific transfer weight (`fastest` ×1, `fewest_transfers` ×100, `lowest_fare` ×0.01) and then recomputes time and fare on the real costs of the chosen path (`core/routing.js: realPathCost`). On today's tree-shaped network all strategies coincide; they differ once an alternative route exists (tested on a hypothetical open Pink underground).

## Fairness optimisation (`docs/algorithms.md` covers the original scorer)
Per participant/candidate: `timeMin` (incl. walking to the access station for Metro), `burdenMin` (= time + preference penalties), `cost`, `interchanges`, `distanceKm`. Group metrics on burden: mean, min, max, range, population standard deviation, total, **Jain's fairness index** `J=(Σx)²/(n·Σx²)`. Hard constraints reject candidates; infeasible/unreachable ones are reported with reasons. Strategies: lexicographic `balanced` (max burden → total → cost → interchanges), `fastest`, `cheapest`, `fewest_transfers`, and `balanced_time_cost` (min-max-normalised weighted score; weights shift with participants' stated time/cost sensitivity; constant metrics normalise to 0; missing cost removes the cost term). Final tie-break is the stable candidate id, so identical inputs give identical rankings.

## Data model (`db/migrations.js`)
`users`, `user_profiles`, `sessions` (hashed tokens), `groups` (mode immutable via trigger), `group_memberships` (composite FK `(group_id, transport_mode)` makes a mixed-mode membership impossible; per-group origin and preferences; agent snapshot + version), `group_invitations` (hashed tokens, expiry, revocation, use counter), `optimization_requests`, `meetup_plans` (append-only versions; per-participant routes and candidate metrics are in `result` jsonb because they are only read with their plan), `plan_venues`, `what_if_scenarios`, `audit_events` (never coordinates), `rate_limits` (DB-backed, works across serverless instances).

## Personal agents and the shared coordination layer (spec §10)
* **Seats** (`group_participants`): the creator names the other participants; each name is a seat that one authenticated account can claim exactly once (atomic `UPDATE … WHERE user_id IS NULL` + partial unique index). A seat also stores that agent's *published* state (travel status, delay, sharing settings, delivery/ack cursors).
* **One lightweight agent per participant** — deterministic code, not a running LLM session: `domain/agentIntents.js` (rules → structured intent), `services/agents.js` (validate → update state → sharing policy → publish). An optional server-side LLM is asked only to classify a message the rules did not understand, and its output must match the same whitelist.
* **Four data classes**: *private* (the conversation, `agent_messages`, readable only by its owner, deleted after 30 days or with the account) · *group* events (structured, whitelisted payload keys — a free-text reason can never be published) · *visible to others* (only group events + roster state a participant allowed) · *internal* (`visibility='internal'` events, delivery cursors — never returned to participants).
* **Shared event system** (`group_events`, append-only): agents never message each other directly. A publisher appends an event; every other agent reads it from the log (`GET …/events?since=`), which advances its `delivered_seq`; `ack` advances `acked_seq` (never beyond what was delivered). The dashboard shows each agent as in sync or catching up. Delivery is *pull-based* (≈15 s polling while a page is open) because the hosting is serverless; there is no WebSocket server.
* **Coordinator reactions** (`services/coordination.js`): a delay ≥ 15 min publishes a *recommendation* (delay-adjusted longest trip and Jain index, suggested later start); a withdrawal or starting-point change marks the proposal out of date and recommends re-running the optimisation. It never creates, edits or confirms a plan: a confirmed plan only changes when the plan creator re-optimises and confirms the new version.
* **Questions** ("What happened to Asha?") are answered deterministically from group events and the roster — never by an LLM — so an agent cannot invent or leak information.
* There is **no group chat**. The older plan Q&A card is per-user and stateless.

## Machine learning
No model is trained or shipped: there is no legitimate dataset, so predictions use a deterministic baseline and say so (`src/ml/registry.js` only accepts a model that has a documented source, a held-out evaluation that beats the baseline and stated limitations). Explanations of the *decision* (`optimizer/explain.js`) come from the optimiser's own numbers; an explanation of a *model prediction* (e.g. SHAP) would be kept separate and labelled.

## Group size and cost
Group size is any number from `GROUP_LIMITS.min` to `GROUP_LIMITS.max` (`src/config/Limits.js`, currently 2–12). Agents are deterministic code per participant (no per-participant model session); the model is only a budgeted fallback (`services/llmBudget.js`), so cost does not grow with group size. Bike routing cost grows with group size (≈ 40 candidates × participants matrix elements), which is why a maximum exists.

## Security model (summary — see tests/security.test.js, tests/groups.test.js, tests/api.test.js)
scrypt password hashes · opaque 256-bit session tokens, hashed at rest, revocable · HttpOnly/SameSite cookies, Secure on https · CSRF by Origin/Sec-Fetch-Site + JSON-only · server-side authorisation on every group resource; non-members get the same `NOT_FOUND` as for missing ids (no enumeration/IDOR) · invitation tokens 256-bit, hashed, expiring, revocable, use-limited, rate-limited, shown once, accepted only in POST bodies · other members' coordinates never returned · parameterised SQL only (statically tested) · output encoding by construction (`app/` has no innerHTML; classic UI escapes) · strict CSP on `/app/*` · generic 500s, no bodies/cookies/coordinates in logs · secrets only from the server environment · LLM prompts use pseudonymised names/ids and no coordinates.

## Privacy and retention
A plan shows every member's route to the meetup point (which implies roughly where they start); the join screen says so. Exact starting points are visible only to their owner. Retention (`services/retention.js`): inactive groups expire after 30 days; cancelled/expired groups are deleted after 30 days (all location data cascades); confirmed groups after 180 days; account deletion wipes starting points, preferences, sessions and profile.

## Offline
`sw.js` precaches the app shell and the classic planner (which is fully client-side, so Metro station-to-station planning works offline). `/api/*` is never cached by the service worker. The last viewed plan per group is stored in `localStorage` with a timestamp and a staleness warning, and cleared on sign-out. Creating/joining groups, fresh road routing, venue lookup and LLM features are online-only; there is no device-to-device sync.
