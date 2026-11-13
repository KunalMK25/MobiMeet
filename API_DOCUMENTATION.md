# API documentation

Base path `/api`. JSON in/out. Authentication is a server-side session in an `HttpOnly; SameSite=Lax` cookie (`mm_session`, `Secure` on https). State-changing requests (`POST/PUT/PATCH/DELETE`) must be same-origin (`Origin` / `Sec-Fetch-Site` are checked) with `Content-Type: application/json`. Bodies are limited to 64 KB. Every response carries `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, a restrictive CSP and `X-Request-Id`.

**Errors** are always `{ "error": { "code", "message" } }`:

| HTTP | codes |
|---|---|
| 400 | `INVALID_INPUT`, `INVALID_MODE`, `MISSING_ORIGIN` |
| 401 | `UNAUTHENTICATED` |
| 403 | `FORBIDDEN` (member but not owner / cross-site request) |
| 404 | `NOT_FOUND` (also returned for groups you do not belong to — existence is never revealed), `INVITE_INVALID` |
| 409 | `CONFLICT`, `DUPLICATE_MEMBER`, `MODE_LOCKED`, `MODE_MISMATCH`, `GROUP_CLOSED`, `NOT_READY` (may include `missing`), `BAD_TRANSITION` |
| 410 | `INVITE_EXPIRED`, `INVITE_REVOKED` |
| 429 | `RATE_LIMITED` (with `Retry-After`) |
| 503 / 504 | `PROVIDER_UNAVAILABLE`, `TIMEOUT` |
| 500 | `INTERNAL` (generic; details are only in server logs) |

**Origin object** — Metro: `{ "stationId": "stn_majestic" }` or a coordinate; Bike: `{ "lat", "lon", "label"? }`. Station IDs come from `GET /api/stations`.

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /api/health` | – | `{ok, routing: 'demo'\|'configured'\|'disabled'}` — Bike routing status (`disabled` = production without a configured provider) |
| `GET /api/stations` | – | operational stations `{id, name, line, lat, lon}` (Pink appears automatically once its section opens) |
| `GET /api/session` | – | `{user}` or `{user:null}` (web-app startup probe) |
| `POST /api/auth/register` | – | `{email, password(≥10), displayName}` → sets cookie |
| `POST /api/auth/login` | – | `{email, password}` (rate-limited per IP and per account) |
| `POST /api/auth/logout` | – | revokes the session |
| `POST /api/auth/forgot` | – | `{email}` → always the same generic reply; in development the link goes to the local outbox |
| `POST /api/auth/reset` | – | `{token, password}` single-use, 30-min token; revokes all sessions |
| `POST /api/auth/logout-all` | ✔ | revokes every session of the user |
| `POST /api/me/password` | ✔ | `{currentPassword, newPassword}` — other sessions are revoked |
| `GET/PATCH /api/me` | ✔ | profile: `displayName`, `defaultPrefs`, `savedPlaces` (≤10) |
| `DELETE /api/me` | ✔ | `{password}` — deletes personal data, anonymises the account, cancels owned groups |
| `GET /api/geocode?q=` | ✔ | address search (Nominatim, Bengaluru-bounded, 30/10 min) |
| `GET/POST /api/groups` | ✔ | list mine / create `{name, mode: METRO\|BIKE, description?, origin?, participantNames?: string[≤5]}` (with `origin` the group opens immediately). `participantNames` creates one **claimable seat** per name; the creator's seat is added automatically. Responses include `participants` (roster) |
| `GET/PATCH /api/groups/:id` | member / owner | read (other members' origins are never included) / rename. Changing `mode` → `MODE_LOCKED` |
| `DELETE /api/groups/:id` | owner | purge a **cancelled/expired** group's data immediately |
| `POST /api/groups/:id/cancel` | owner | cancel and revoke all invitations |
| `PUT /api/groups/:id/me` | member | my `origin`, `softPrefs`, `hard` constraints (bumps agent version; marks the plan stale) |
| `POST /api/groups/:id/leave` | member | leave (owner cannot) |
| `DELETE /api/groups/:id/members/:userId` | owner | remove a participant |
| `POST/GET /api/groups/:id/invitations` | owner | create `{ttlHours 1–168, maxUses 1–50}` (raw token returned **once**) / list (no tokens) |
| `DELETE /api/groups/:id/invitations/:invId` | owner | revoke |
| `POST /api/invitations/preview` | – | `{token}` → `{groupName, mode, namedSeats, participants:[{id,name,claimed}]}` — names and availability only |
| `POST /api/invitations/join` | ✔ | `{token, origin, participantId, mode?, softPrefs?, hard?}` — atomic. If the group has named seats `participantId` is required and the seat is claimed in the same transaction: already claimed / unknown → `CONFLICT`; account already seated → `DUPLICATE_MEMBER`; no seat chosen → `INVALID_INPUT` |
| `POST /api/groups/:id/optimize` | owner | `{strategy?, fuel?}` → new plan version |
| `GET /api/groups/:id/plans` · `…/plans/:planId\|current` | member | history / one plan |
| `POST …/plans/:planId/confirm` | owner | confirm (rejected if inputs changed since); supersedes older confirmed plan, never overwrites it |
| `GET …/plans/:planId\|current/venues?categories=&radiusKm=&refresh=1` | member | places near the meetup |
| `POST …/plans/:planId\|current/phrase` | member | optional LLM re-wording; numbers verified or deterministic text returned |
| `POST/GET /api/groups/:id/whatif` | member | run / list scenarios (never change the group or plans) |
| `POST /api/groups/:id/whatif/compare` | member | `{ids:[…≤5]}` side-by-side vs the current plan |
| `POST /api/groups/:id/me/parse-notes` | member | `{text}` → suggested prefs (never auto-applied) |
| `GET /api/groups/:id/agent` | member | my agent: published status, sharing settings, sync cursors (`head`, `delivered`, `acked`) |
| `GET/POST /api/groups/:id/agent/messages` | member | **private** conversation with MY agent (only I can read it). POST `{text ≤500}` → `{reply, intent, understoodBy: rules\|llm, published: {seq,type}\|null}` |
| `PUT /api/groups/:id/agent/sharing` | member | `{delays?, arrival?, location?}` booleans; withdrawal and plan responses are not optional |
| `GET /api/groups/:id/events?since=` | member | the shared coordination layer: structured `group` events after `since`; reading marks them delivered to my agent. `internal` events are never returned |
| `POST /api/groups/:id/events/ack` | member | `{seq}` — acknowledge up to what my agent actually received |
| `GET /api/groups/:id/dashboard` | member | joined/pending, each agent's published state and sync, plan responses, coordinator recommendation (owner also sees which account holds each seat) |
| `POST /api/chat` | ✔ | `{groupId, message}` plan-grounded assistant |
| `GET /api/maintenance` | cron secret | retention job (404 unless `CRON_SECRET` matches) |

**Optimisation request** `routeStrategy` (Metro, optional): `fastest` (default), `fewest_transfers`, `lowest_fare` — how each person's route is *chosen* when more than one exists; reported time/fare are always those of the chosen route. Stored in the plan and part of its reproducibility hash. `fuel` (Bike, optional): `{mileageKmPerLitre, fuelPricePerLitre, priceDate?, priceSource?}` — cost is shown only when both numbers are supplied. **Strategies:** `balanced` (default), `fastest`, `cheapest` (needs cost data), `fewest_transfers`, `balanced_time_cost`.

**Plan result** (`plan.result`): `mode, strategy, recommended{id,label,areaName?,lat,lon,metrics,journeys[]}, alternatives[], ranking[], bestBy{}, explanation{facts,lines,limitations}, warnings[], routing?, fuelAssumptions?, participants[]`. Journeys carry `timeMin, burdenMin, cost, interchanges, distanceKm` and mode-specific `detail` (Metro: path/lines/interchanges/access station; Bike: distance/geometry/quality). `warnings` codes mark every estimate or fallback.
