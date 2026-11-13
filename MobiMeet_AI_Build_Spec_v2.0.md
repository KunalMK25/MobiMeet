# MOBIMEET AI — COMPLETE BUILD SPECIFICATION
**Document type:** Product, Architecture, Engineering and Implementation Source of Truth  
**Version:** 2.0  
**Date:** 13 November 2026  
**Project:** MobiMeet AI (evolution of MetroMeet AI)  
**Existing baseline repository:** https://github.com/KunalMK25/metromeet-ai  
**Existing deployment:** https://metromeet-ai.vercel.app/

---

## 0. Purpose and Authority

This document defines the product, constraints, architecture, implementation expectations, acceptance criteria and delivery process for evolving MetroMeet AI into **MobiMeet AI**.

This file is the primary project specification for Claude Code. The GitHub repository is the source of truth for actual code, dependencies, existing functionality, data structures, tests and deployment configuration.

### Source-of-truth hierarchy

1. **This BuildSpec:** product intent, required behaviour, constraints and acceptance criteria.
2. **Existing repository:** actual implementation, conventions, dependencies, data structures, tests and deployment setup.
3. **Official external sources:** current BMRCL metro information, map/routing provider documentation and framework/API documentation.
4. **Implementation decisions:** choose the simplest maintainable option consistent with the above and document material decisions.

Do not assume a feature exists merely because it is described here. Inspect the repository and classify each feature as implemented, partial, missing, broken or requiring replacement. Do not discard working MetroMeet functionality without a documented technical reason.

### Mandatory instructions for Claude Code

- Read this entire document before changing code.
- Inspect the complete repository, tests, package files, environment examples, documentation, deployment configuration and Git history where useful.
- Run baseline tests/build before implementation.
- Create or update `IMPLEMENTATION_AUDIT.md` with the current state and dependency-aware plan.
- Continue through feasible phases without stopping for routine approval after every phase.
- Ask only when a genuinely critical product decision, unavailable credential, irreversible action or ambiguous requirement cannot safely be inferred.
- Implement working end-to-end features, not just UI mockups, stubs, fake data or empty API routes.
- Test continuously; distinguish pre-existing failures from regressions.
- Update documentation and `.env.example`.
- Never expose secrets, tokens, private user data or production environment values.
- Do not commit or push unfinished or unverified work. Push only after acceptance checks pass, changes are reviewed and the user authorizes the push.

---

# 1. Product Overview

## 1.1 Product identity

**MobiMeet AI — Personalized Multi-Agent Group Mobility Planning.**

MobiMeet AI helps a group of people starting from different locations find a fair and practical common meetup location. Rather than requiring the group to choose a destination first, the system evaluates possible meetup locations using each participant's travel burden, transport mode, preferences and constraints.

The system supports exactly two mutually exclusive transport modes:

- **Metro**
- **Bike**

A group chooses one mode when it is created. Every participant in that group must use the same mode. Mixed Metro/Bike groups are invalid.

## 1.2 Evolution from MetroMeet AI

MobiMeet AI is an evolution of the existing MetroMeet AI project, not a clean-slate rewrite.

The existing baseline may include:
- Bengaluru Metro network graph and station data.
- Dijkstra-based shortest-path routing.
- Line-aware route calculations.
- Interchange detection.
- Route reconstruction.
- Fare estimation.
- Travel-time estimation.
- Fairness-first meetup candidate evaluation.
- Station attractiveness/candidate scoring.
- Places discovery using OpenStreetMap and fallback data.
- Map visualization and Canvas rendering.
- Station/location autocomplete.
- Context-aware AI assistance.
- Diagnostics and performance improvements.

Claude Code must verify every item against the repository and preserve working modules.

## 1.3 Problem statement

When several people want to meet, each person may start from a different location and have different travel preferences. Choosing a meetup location informally can impose an unfair travel burden on some participants.

MobiMeet AI should:
- Evaluate the journey for every participant.
- Compare candidate meetup locations.
- Balance group convenience rather than optimizing only one person's journey.
- Explain why a location was selected.
- Show each participant's route, estimated time and cost.
- Allow the group to compare alternatives and change preferences.

## 1.4 Product principles

1. Fairness before convenience for one individual.
2. Explainability: distinguish predictions from calculated or verified values.
3. Data integrity: never present stale, estimated, synthetic or unavailable data as verified live data.
4. Transport-mode separation: Metro and Bike use different routing engines and data models.
5. Modularity: new lines, stations, routing providers, ML models and venue providers must be addable without rewriting the application.
6. Privacy and security for participant locations and group details.
7. Graceful degradation when external services fail.
8. Preserve and extend the working MetroMeet baseline.

---

# 2. Scope and Non-Goals

## 2.1 Required capabilities

- Registration, login and profile management.
- Participant origin and travel preference management.
- Group creation and secure invitation links.
- Group joining and participant onboarding.
- Exactly one transport mode per group.
- Participant-specific agent representations.
- Metro routing and meetup optimization.
- Bike road routing and meetup optimization.
- Fairness-aware group optimization.
- Nearby venue discovery and ranking.
- Individual route and cost breakdowns.
- Recommendation explanations.
- ML-assisted predictions where supported by suitable data.
- SHAP explanations for supported ML predictions.
- Shared group plans and membership management.
- What-if comparisons.
- Caching and limited offline access.
- Responsive and accessible UI.
- Tests, documentation, security and deployment readiness.

## 2.2 Explicit non-goals unless separately approved

- Mixed Metro-and-Bike groups.
- Claiming real-time traffic or train arrivals without a reliable integrated provider.
- Claiming exact fuel expenditure when only an estimate is available.
- Treating a straight-line midpoint as the final Bike meetup answer.
- Using an LLM as the authority for shortest-path calculations, fares, route feasibility or fairness arithmetic.
- Unbounded agent-to-agent conversations.
- Fabricating training data, model metrics or evaluation results.
- Building a native mobile application unless separately approved.
- Guaranteeing device-to-device synchronization while offline.

---

# 3. Repository Audit — Mandatory First Step

**Repository:** https://github.com/KunalMK25/metromeet-ai  
**Existing deployment:** https://metromeet-ai.vercel.app/

The repository determines the current technical implementation.

## 3.1 Audit checklist

Inspect:
- Complete folder and module structure.
- Frontend entry points, components, state management and styling.
- Backend/API routes and serverless functions.
- Metro graph, station/line records and interchange representation.
- Dijkstra implementation and route reconstruction.
- Fare and travel-time calculations.
- Meetup candidate generation and fairness scoring.
- Places provider, map rendering, autocomplete and fallback data.
- AI integration and context management.
- Database or persistence layer.
- Authentication and authorization.
- Environment variable names and `.env.example` (never print secret values).
- Unit, integration and end-to-end tests.
- Build, lint, type-check and verification scripts.
- Vercel configuration and deployment assumptions.
- README and project documentation.
- Git status, active branch and recent commit history where useful.

## 3.2 Baseline report

Create/update `IMPLEMENTATION_AUDIT.md` with:
- Feature inventory: working / partial / missing / broken.
- Current stack and important dependencies.
- Existing architecture and data flow.
- Current metro network coverage and data source.
- Test/build commands and baseline results.
- Known defects and technical debt.
- Risks and external credentials required.
- Recommended implementation sequence.

The historical baseline was reported to have `npm run verify` and `npm run build` passing. Recheck the current repository; do not assume these results remain true.

---

# 4. Users, Profiles and Core Data

## 4.1 User account

Support a unique user ID, display name, authentication identifier, securely managed credentials, profile preferences and account timestamps. Never store plaintext passwords. Prefer a mature authentication implementation compatible with the existing stack.

## 4.2 Participant travel profile

A participant may provide:
- Starting location (map selection, address search or supported location input).
- Optional saved home/work/frequent origin.
- Preferred meetup characteristics.
- Maximum acceptable travel time or distance, if supplied.
- Cost sensitivity.
- Preference for fewer interchanges (Metro).
- Preference for shorter distance or lower estimated fuel cost (Bike).
- Voluntarily supplied accessibility/mobility constraints where needed.
- Optional group-specific notes or constraints.

A group-specific origin must not silently overwrite the user's saved profile origin. Collect only information necessary for the mobility plan. Do not infer sensitive personal attributes.

## 4.3 Group model

A group should contain:
- Unique group ID.
- Creator/owner ID.
- Group name or optional description.
- Transport mode: `METRO` or `BIKE`.
- Status: draft, open, optimizing, proposed, confirmed, cancelled or expired.
- Participant membership records.
- Invitation token metadata.
- Meetup objective/preferences.
- Created/updated timestamps.
- Selected plan and plan version where applicable.

Enforce exactly one transport mode in backend validation and, where practical, database constraints—not only in the UI.

## 4.4 Membership model

A membership record should include group ID, user ID or securely represented invitee identity, role, join status, group-specific origin, group-specific preferences/constraints, agent input snapshot/version and timestamps.

---

# 5. Group Lifecycle and Invitations

## 5.1 Expected workflow

1. User registers/logs in.
2. User completes or updates their travel profile.
3. User creates a meetup group.
4. Creator chooses `METRO` or `BIKE`.
5. System creates a secure invitation link.
6. Creator shares it.
7. Invitees authenticate or complete the permitted joining flow.
8. Each participant enters/confirms their origin and preferences.
9. Backend validates invitation, group status and transport mode.
10. Participant joins.
11. System creates/updates that participant's agent representation.
12. Creator requests optimization when required information is available.
13. Coordinator invokes the correct transport engine and group optimizer.
14. Group receives a recommended meetup location, individual route breakdowns and alternatives.
15. Participants can compare alternatives and update inputs.
16. Confirmed plan is stored and shared with authorized members.

## 5.2 Invitation security

- Use cryptographically secure, unguessable invitation tokens.
- Store token hashes rather than raw tokens where practical.
- Support expiration and revocation.
- Enforce group status and membership rules.
- Rate-limit token validation/join endpoints.
- Do not expose participant origins or private group data to arbitrary link holders.
- Provide a safe flow for invitees who are not logged in.
- Do not allow participants to change the group's transport mode after joining.
- Validate all group and participant IDs server-side.

## 5.3 Validation cases

Reject or safely handle expired/revoked invitations, closed groups, invalid modes, duplicate membership, missing origins, incomplete required preferences, conflicting transport mode and unauthorized access.

---

# 6. Metro Routing Engine

## 6.1 Purpose

Calculate feasible journeys over the configured Bengaluru Metro network and evaluate candidate meetup stations for every participant. Reuse the existing MetroMeet graph and routing implementation wherever sound.

## 6.2 Graph representation

- Nodes: stations or station-platform states, depending on the existing routing model.
- Edges: valid adjacent-station connections.
- Edge attributes: line, distance, estimated travel time, operational status and verified metadata.
- Interchanges: valid transfers between lines at the same interchange station.
- Station metadata: stable ID, official name, aliases, coordinates, line membership, verified amenities/accessibility metadata and operational status.

Use stable station IDs, not display names, as unique identifiers.

## 6.3 Routing algorithm

Use Dijkstra's algorithm for non-negative edge weights. Reuse the existing line-aware implementation if it correctly models interchanges and transfer penalties.

Support strategies where data permits:
- Shortest travel time.
- Lowest estimated fare.
- Fewest interchanges.
- Balanced route cost.

Normalize incomparable units before combining metrics. Return origin/destination, ordered station sequence, line sequence, interchanges, in-vehicle time, transfer/wait allowance if modelled, total estimated time, estimated fare, distance where available, data source/freshness and warnings for estimates/incomplete data.

## 6.4 Access and egress

A participant's geographic origin may not be a metro station. Identify plausible nearby access stations using coordinates and a documented method. Include first/last-mile burden where feasible. Distinguish actual metro routing from approximate walking estimates. Do not assume the nearest station is always the participant's intended access station.

## 6.5 Bengaluru Metro network and Pink Line

**Pink Line is explicitly in scope.**

The corridor is planned between Kalena Agrahara and Nagawara. Verify current station sequence, segment connectivity and interchange relationships using authoritative sources.

The implementation agent must check current operational status against the latest official BMRCL information at implementation time. This document is not a live status feed.

Model operational status at segment/station-connection level:
- Open sections may be used for current route recommendations.
- Not-yet-open sections may be represented as planned/under construction.
- Planned sections must be excluded from currently available passenger journeys.
- Future openings should be enabled through data/configuration changes, not routing rewrites.

Pink Line requirements:
- Represent elevated and underground sections accurately.
- Include correct station order and connections.
- Model Jayadeva Hospital as an interchange only when the relevant connecting line/connection is operational.
- Do not assume announced stations or corridor sections are open.
- Store source, verification date and status for each segment.
- Add regression tests for Pink Line routes and interchanges.

The same status-driven model must support future metro extensions and lines.

## 6.6 Metro data governance

Prefer official BMRCL sources for station names, alignments and operational status. Record source URL/name, date checked, status and assumptions. If authoritative information is unavailable, mark it unverified and do not present it as confirmed.

---

# 7. Bike Routing Engine

## 7.1 Purpose

Evaluate road-network journeys between participant origins and candidate meetup locations. Bike routing is separate from the Metro graph.

## 7.2 Routing provider

OpenStreetMap may provide map/road data. OSRM or another compatible road-routing provider may be used, subject to availability, licensing, usage policies and deployment needs.

- Inspect existing provider integrations first.
- Use a provider abstraction.
- Respect public service policies and rate limits.
- Do not assume a public demo endpoint is production-ready.
- Keep provider credentials server-side.
- Cache responses where permitted.

## 7.3 Route result

Return origin/destination coordinates, road geometry where available, distance, estimated duration, estimated fuel consumption/cost only with explicit assumptions, provider and data timestamp, and warnings/fallback status.

Do not label a route real-time traffic-aware unless a traffic-enabled provider is integrated.

## 7.4 Fuel cost

Fuel cost is an estimate. Document fuel price source/date, assumed mileage and formula:

`estimatedFuelCost = (routeDistanceKm / mileageKmPerLitre) * fuelPricePerLitre`

If mileage or fuel price is unavailable, omit the estimate or show a clearly labelled configurable assumption. Never invent a current fuel price.

## 7.5 Candidate generation

Candidates may be generated from participant-origin clustering, reachable road-network areas, POIs or a bounded search region. A straight-line centroid/midpoint may generate initial candidates, but cannot be the final fairness decision. Evaluate candidate journeys using road-network routes and participant burden.

---

# 8. Fairness-First Meetup Optimization

## 8.1 Objective

Select a candidate that balances travel burden across participants. Do not optimize only the fastest individual, average time while ignoring outliers, geographic midpoint or lowest total cost if it creates unreasonable burden for one participant.

## 8.2 Candidate metrics

For each participant/candidate, calculate available metrics:
- Travel time.
- Travel distance.
- Estimated cost.
- Metro interchanges.
- Access/egress burden where available.
- Constraint violations.
- Route feasibility and data confidence.

## 8.3 Group fairness metrics

At minimum evaluate mean, maximum and minimum travel time, travel-time range, standard deviation or another documented dispersion measure, a justified fairness measure, total group travel time and total estimated cost.

Define formula behaviour and edge cases. Do not use a fairness score without documenting it.

## 8.4 Strategies

Support a primary fairness-first strategy and transparent alternatives:
- **Balanced/Fair:** minimize worst individual burden, then reduce group total.
- **Fastest:** minimize total/average travel time subject to feasibility.
- **Cheapest:** minimize total estimated group cost.
- **Fewest transfers:** reduce Metro interchange burden.
- **Balanced time/cost:** use normalized metrics and documented weights.

A possible lexicographic objective:
1. Reject infeasible candidates and hard-constraint violations.
2. Minimize maximum participant burden.
3. Minimize total group burden.
4. Use cost, interchanges or preferences as tie-breakers.

This is a proposed starting point; retain a better existing mathematically justified implementation if supported by tests and documentation.

Normalize time, distance, cost and interchange metrics before combining them. Document normalization, weights, defaults, missing-value behaviour and tie-breaking. Keep score breakdowns inspectable.

## 8.5 Explanations

For each recommendation explain why it was selected, how it compares with alternatives, longest individual journeys, group balance, cost/interchange trade-offs and data limitations. Generate explanations from actual optimizer outputs. An LLM may phrase the explanation but must not invent or alter numbers.

---

# 9. Participant Agents and Group Coordinator

## 9.1 Design intent

Each participant has a logical agent representation for their current group inputs. An agent may be a deterministic component, LLM-assisted component or hybrid. Separate long-running LLM processes per participant are not required.

## 9.2 Agent responsibilities

- Receive authorized group-specific origin/preferences.
- Validate required inputs.
- Produce structured participant representation.
- Identify constraints and preferences.
- Provide structured preference signals to coordinator.
- Update when participant inputs change.
- Avoid unauthorized access to other participants' private profiles.

## 9.3 Structured output

Use a validated schema containing participant ID, origin reference/coordinates, transport mode, hard constraints, soft preferences, cost/time sensitivity, optional accessibility constraints, data completeness and version/timestamp.

Do not pass uncontrolled free-form text into the optimizer.

## 9.4 Coordinator

- Verify group membership.
- Verify all participants use the group's mode.
- Check data completeness.
- Collect structured agent outputs.
- Call correct Metro/Bike engine.
- Generate/receive candidate locations.
- Call deterministic fairness optimizer.
- Return structured plan and explanation inputs.
- Track plan versions and changes.

## 9.5 Safety and cost controls

Bound agent loops, retries and timeouts. Validate LLM outputs. Keep routing and optimization outside LLM control. Minimize personal data sent to LLM providers. Never expose API keys in the browser. Provide deterministic fallback when LLM services fail. Avoid unnecessary logging of sensitive location details.

---

# 10. Machine Learning and SHAP

## 10.1 Potential use cases

Potential ML tasks include travel-time prediction/calibration, preference modelling, candidate ranking assistance and cost calibration where reliable labels exist. Do not add ML for appearance; each model must solve a defined task and be evaluated against a baseline.

## 10.2 Data requirements

Identify legitimate sources and usage rights. Define target/features and provenance. Check missingness, bias and leakage. Split data appropriately. Do not use synthetic data as proof of real-world performance.

If suitable data is unavailable, implement a deterministic baseline and define the ML integration interface for later. Do not fabricate a trained model or metrics.

## 10.3 Model lifecycle

Document model purpose, dataset/source, feature definitions, training procedure, validation/test methodology, baseline comparison, appropriate metrics, model version, limitations/bias and retraining approach if justified.

Do not add automated retraining without validated pipelines, monitoring, rollback and model evaluation.

## 10.4 SHAP

Use SHAP only for supported ML models/predictions. SHAP explains feature contributions to a model prediction; it does not explain the entire group optimization process.

Keep separate:
1. **Model explanation:** why the model predicted a travel time/preference.
2. **Decision explanation:** why the deterministic optimizer selected a meetup candidate.

Show uncertainty and limitations. SHAP does not prove objective fairness.

---

# 11. Nearby Venue Discovery

After selecting a station or geographic area, show relevant places.

**Metro:** search around the selected station or a configurable walking radius.  
**Bike:** search around the selected geographic meetup point, initially considering a configurable radius around 2–3 km where suitable.

Ranking may consider distance, category/suitability, verified opening hours, user preferences and legitimate rating/review data. Never invent ratings, hours, names or availability.

Reuse reliable existing Places/OpenStreetMap integration. Use provider abstractions, caching where permitted and clear empty/error states. Label static fallback data as sample/fallback data. Respect licensing and attribution.

---

# 12. User Interface and Experience

## 12.1 Core flows

Provide clear account/profile experience, Create Group, Metro/Bike selection, invitation/join flow, participant list/completion status, origin/preferences input, optimization progress/error states, recommended meetup, individual routes, fairness comparison, nearby venues, alternatives, what-if comparison and plan confirmation.

## 12.2 Metro map

Preserve and improve the existing MetroMeet map where appropriate:
- Stations and lines.
- Distinction between operational and planned sections.
- Selected participant routes.
- Interchanges.
- Station search/autocomplete.
- Legible overlapping routes and labels.
- Accessible non-map route summaries.

## 12.3 Bike map

Show participant origins, candidate meetup point, road routes when geometry is available, distance/time, selected venue and a list-based alternative.

## 12.4 Responsive/accessibility

Support desktop/mobile, keyboard navigation, accessible labels/focus states, non-colour-only status communication, loading/empty/error/success states and non-blocking long calculations.

Inspect and preserve existing Canvas rendering/performance optimizations if working. Do not replace a performant renderer without measured justification.

---

# 13. Technical Architecture and Stack

The following is the intended direction, not permission to replace working repository technology without an audit.

## 13.1 Proposed stack

- **Frontend:** retain existing framework; if none is established, follow the existing HTML/CSS/JavaScript baseline.
- **Backend:** Node.js and existing API/serverless architecture.
- **Hosting:** existing Vercel deployment, subject to compatibility.
- **Database:** PostgreSQL for accounts, profiles, groups, membership, preferences and plans.
- **Metro routing:** graph data and Dijkstra-based engine.
- **Bike routing:** OpenStreetMap with OSRM or another suitable road-routing provider.
- **ML:** Python, Scikit-learn, Pandas and NumPy where justified.
- **Explainability:** SHAP for supported ML models.
- **LLM integration:** OpenAI API and/or Anthropic Claude API for carefully scoped runtime AI features. ChatGPT and Claude are also research/development tools; they are not runtime dependencies for core routing.
- **Development IDEs:** Visual Studio Code and Kiro.
- **Version control:** Git and GitHub.
- **API testing:** Postman or existing automated API tooling.
- **Testing:** preserve and extend the repository's current test framework.

## 13.2 Boundaries

Separate responsibilities for authentication/authorization, profiles/preferences, groups/invitations, Metro routing, Bike routing, candidate generation, fairness optimization, agent coordination, ML inference, venue discovery and plan persistence/versioning.

Avoid a single giant API handler.

## 13.3 Provider interfaces

Use replaceable interfaces for map data, road routing, venue discovery, LLM providers, ML inference and persistence where justified.

## 13.4 Environment configuration

Maintain safe `.env.example` with variable names and non-secret placeholders only. Configuration categories may include database, auth/session signing, OpenAI, Anthropic, map/routing provider, venue provider, app base URL and feature flags. Use actual repository variable names. Never commit `.env`, keys, tokens, passwords or production credentials.

---

# 14. Database and Persistence

If PostgreSQL is introduced or already present, use migrations and document the schema.

Expected logical entities:
- User.
- UserProfile.
- Group.
- GroupInvitation.
- GroupMembership.
- ParticipantPreference or GroupParticipantInput.
- ParticipantAgentSnapshot.
- MeetupOptimizationRequest.
- MeetupCandidate.
- ParticipantRoute.
- MeetupPlan.
- VenueRecommendation.
- ModelVersion/prediction metadata where required.
- AuditEvent for security-relevant actions.

Derive the final schema from the repository and product needs. Avoid redundant tables and unnecessary personal data.

Persist group state and confirmed plans. Track plan versions when inputs change. Do not silently overwrite confirmed plans. Enforce referential integrity, indexes and transactions where needed. Define retention/deletion behaviour for personal location data.

---

# 15. Privacy, Security and Reliability

Implement secure authentication, server-side authorization on every private group resource, secure expiring/revocable invitation tokens, input validation, output encoding, rate limiting, safe CORS/security headers, server-side secret management, parameterized database access, protection against IDOR, minimal location logging and safe error messages.

A user must not retrieve another group's origins, routes or participant details by changing an ID in a request.

---

# 16. Offline and Caching

Potential offline capabilities:
- Previously loaded Metro network data.
- Previously saved group plan.
- Previously calculated route summaries.
- Cached station/venue information where permitted.
- Local display of saved plans.
- Limited deterministic calculations using cached data where safe.

Online-only capabilities may include joining groups, creating/revoking invitations, fresh road routing, external venue lookup, LLM requests, live status refresh and cross-device synchronization.

Offline access does not guarantee live device-to-device communication. Do not claim peer-to-peer synchronization unless separately designed, implemented and tested. Show cache timestamps and stale-data warnings.

---

# 17. What-If Analysis and Alternative Plans

Allow authorized users to compare scenarios:
- Add/remove participant.
- Change participant origin.
- Change preferences.
- Change optimization strategy.
- Compare meetup candidates.
- Compare cost/time trade-offs.

Scenario calculations must not silently modify the confirmed plan. Keep scenarios separate until the group confirms a new plan.

---

# 18. API and Domain Contracts

Define contracts consistent with the repository. Expected operations include:
- Register/login/logout or equivalent.
- Read/update profile.
- Create/read group.
- Create/revoke/validate invitation.
- Join group.
- Update participant group input.
- Remove/leave participant subject to permissions.
- Request/read optimization.
- Read participant routes.
- Compare scenarios.
- Confirm plan.
- Read/refresh venues and supported data.

For each operation validate input, authenticate caller, authorize group access, return structured responses, use consistent errors and test successful/unauthorized cases. Do not duplicate existing APIs unnecessarily.

---

# 19. Testing and Quality Assurance

## 19.1 Baseline

Run existing tests before changes and preserve the current test framework unless there is a strong reason to change it.

## 19.2 Unit tests

Test:
- Metro graph construction and station ID uniqueness.
- Pink Line station/segment status.
- Interchange validity.
- Dijkstra correctness and route reconstruction.
- Fare/time calculations.
- Bike route parsing.
- Fuel formula and missing-data handling.
- Candidate generation.
- Fairness metrics and normalization.
- Tie-breaking and hard constraints.
- Group mode validation.
- Invitation validation.
- Participant authorization.
- Agent schema validation.
- ML inference validation.

## 19.3 Integration tests

Test:
- Full Metro group optimization.
- Full Bike group optimization.
- Group creation and invitation join.
- Mixed-mode rejection.
- Missing origin handling.
- Venue provider failure.
- Persistence and plan versioning.
- Unauthorized access rejection.
- LLM provider unavailable fallback.
- Routing provider unavailable fallback.

## 19.4 Regression tests

Existing MetroMeet station search, map rendering, route display/calculations, fare/time calculations, places experience and fairness functionality must remain functional.

## 19.5 Build and verification

Confirm actual scripts in the current package files. Historical commands included:
- `npm run verify`
- `npm run build`

Also run lint, type checks and end-to-end tests if configured.

## 19.6 Quality gates

A phase is complete only when functionality is connected to the real application, relevant tests pass, no new build/lint/type errors are introduced, security/error paths are handled, documentation is updated and browser interaction is manually checked where relevant.

---

# 20. Implementation Roadmap

Claude Code should work through these phases in dependency order and continue autonomously through feasible work.

## Phase 0 — Audit and baseline
Inspect repository, run baseline tests/build, create `IMPLEMENTATION_AUDIT.md`, identify reusable modules/blockers and prepare execution plan.

**Exit:** verified baseline and plan.

## Phase 1 — Domain and architecture
Define transport mode, group lifecycle, participant contracts, provider interfaces, validation and error conventions. Add migrations only if needed.

**Exit:** tested domain types/contracts.

## Phase 2 — Metro network update
Verify Bengaluru Metro data and Pink Line status from official sources. Add verified stations, edges and interchanges. Model operational/planned sections. Add route regression tests and configurable line data.

**Exit:** operational network routes correctly; planned sections are excluded from live routes.

## Phase 3 — Authentication, profiles and groups
Complete auth, profiles/preferences, group creation, invitation lifecycle, participant joining and mode validation.

**Exit:** secure end-to-end group onboarding.

## Phase 4 — Metro group optimization
Connect participants to Metro engine, generate meetup station candidates, evaluate all routes, integrate fairness and alternatives, display time/fare/interchanges.

**Exit:** a real group receives a reproducible Metro meetup recommendation.

## Phase 5 — Bike routing
Integrate road provider, abstraction and caching; generate geographic candidates; evaluate road routes; implement transparent distance/time/fuel estimates; handle failures.

**Exit:** a real group receives a Bike recommendation based on road-network routes.

## Phase 6 — Agents and coordinator
Implement participant components, schemas, coordinator, mode/membership enforcement, bounded timeout/retry and fallback.

**Exit:** reliable structured orchestration without uncontrolled agent loops.

## Phase 7 — ML and SHAP
Define prediction tasks, validate datasets, build baseline, train/evaluate only with suitable data, integrate inference and SHAP, retain deterministic fallback.

**Exit:** evaluated model with documented limitations, or documented deterministic baseline/interface where valid data is unavailable.

## Phase 8 — Venues and explanations
Improve venue discovery, ranking/caching, optimizer-backed explanations and alternative comparisons.

**Exit:** users understand recommendations and can discover venues.

## Phase 9 — What-if, shared plans and offline
Implement scenario comparison, plan versioning/confirmation, saved-plan access, cache freshness and limited offline viewing/calculation.

**Exit:** scenarios do not corrupt confirmed plans; offline limits are explicit.

## Phase 10 — Hardening and release
Complete regression/integration/end-to-end tests, security/privacy review, provider limits/failure paths, responsive/accessibility review, documentation and production build.

**Exit:** acceptance criteria pass and user reviews the result.

---

# 21. Acceptance Criteria

## 21.1 Existing baseline
- Working MetroMeet features remain available.
- Map and route experiences are not regressed.
- Existing verification/build passes, or pre-existing failures are documented and not worsened.

## 21.2 Metro
- Stable station IDs and valid connections.
- Correct Dijkstra routes for tested cases.
- Correct interchanges.
- Pink Line included with verified status.
- Planned/inactive sections excluded from active routes.
- New-line routes pass regression tests.

## 21.3 Bike
- Road-network provider used, not only straight-line distance.
- Every participant evaluated for candidate locations.
- Distance and duration labelled clearly.
- Fuel cost uses documented assumptions or is omitted.
- Provider failure/stale data handled.

## 21.4 Group
- Users can create groups and invite others.
- Secure invitation join works.
- Group-specific origins supported.
- Exactly one transport mode per group.
- Mixed-mode membership rejected.
- Authorized members can view plans.

## 21.5 Optimization
- Identical inputs/data produce deterministic scores.
- Fairness metrics documented.
- Individual routes and burden visible.
- Alternatives comparable.
- Explanations reflect actual optimizer outputs.

## 21.6 Agents and ML
- Agent schemas validated.
- Orchestration has bounded retries/timeouts.
- LLM failure does not break core routing/optimization.
- ML is not presented as trained without evaluation.
- SHAP used only where appropriate.
- Model and decision explanations are distinct.

## 21.7 Security and quality
- Private group data protected by server-side authorization.
- Invitation tokens expire and can be revoked.
- Secrets are not committed.
- Important failure paths tested.
- Build/test results recorded.
- Documentation supports another developer setting up the project.

---

# 22. Documentation Deliverables

Keep these current, creating them if missing:
- `Build_Spec.md` — this source-of-truth specification.
- `IMPLEMENTATION_AUDIT.md` — repository baseline and feature inventory.
- `README.md` — overview, setup and usage.
- `ARCHITECTURE.md` — components, boundaries and data flow.
- `DATA_SOURCES.md` — metro, map, routing and venue sources with dates/licensing.
- `API_DOCUMENTATION.md` or generated API docs where appropriate.
- `ML_MODEL_CARD.md` only if a model is actually trained and integrated.
- `.env.example` — variable names and safe placeholders.
- Release notes/changelog.

Do not duplicate this entire BuildSpec in every document. Refer to it as the primary specification.

---

# 23. Git, Commit and Push Policy

Before a commit:
1. Check `git status`.
2. Confirm intended branch.
3. Review the diff.
4. Check for secrets, generated files, local data and unrelated changes.
5. Run relevant tests and full verification/build.
6. Ensure documentation and environment examples are safe.
7. Summarize changes and known limitations.

Use logical, reviewable commits with descriptive messages.

**Push only after required acceptance checks pass and the user has reviewed and authorized the push.** If credentials, branch protection or permissions prevent a push, report the blocker and leave the work in a clean, reviewable state. Never claim a commit/push succeeded unless Git confirms it.

Do not force-push, rewrite shared history or delete branches without explicit authorization.

---

# 24. Final Implementation Report

At completion, report:
- Features completed.
- Features partially completed/deferred.
- Important architecture decisions.
- Metro/Pink Line data source and verification date.
- Bike routing provider and limitations.
- ML status/evaluation, if applicable.
- Tests/build commands and results.
- Security/privacy work completed.
- Environment variable names the user must configure (names only).
- Commit hash/branch if committed.
- Push status/remote branch if pushed.
- Deployment URL/status if deployed.
- Known limitations and next steps.

Never report a feature complete if it is only a mockup, stub, hardcoded demonstration or untested path.

---

# 25. Final Instruction to Claude Code

Treat this document as the product and engineering contract. Treat the GitHub repository as the authoritative record of the actual implementation.

Start by auditing the repository and validating the current baseline. Then evolve MetroMeet AI into MobiMeet AI in dependency order, preserving working functionality. Implement feasible requirements end-to-end, test continuously, document decisions and blockers, and do not stop for routine approval between phases.

Use sound engineering judgment where details are unspecified. Ask only for decisions that cannot safely be inferred. Do not fabricate data, model results, operational metro status, provider capabilities or test outcomes.

Do not commit or push until implementation is complete, acceptance checks pass, changes have been reviewed and the user authorizes the push.

**The goal is a functioning, maintainable MobiMeet AI application—not merely a completed checklist or an impressive-looking prototype.**
