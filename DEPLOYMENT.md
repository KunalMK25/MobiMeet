# Setup, deployment and operations

Two apps share this repository: the original **Quick Metro planner** (`/`, static, no server, no environment variables) and the **MobiMeet app** (`/app/`, needs the `/api` function and a PostgreSQL database).

## Project rules
* MobiMeet is a **personal/academic project**. It must not use any employer credentials, APIs, repositories or infrastructure, and it must not bypass laptop security tooling. Only personally authorised accounts are used.
* Secrets live only in a local, git-ignored `.env` and in Vercel's environment-variable settings — never in Git, chat, logs or screenshots. `.env.example` holds names and placeholders only. A test fails if a secret-shaped string is committed.
* **Nothing is committed, pushed, merged or deployed without the owner's explicit approval** (commit, push and deploy are separate approvals). The existing production deployment and the `main` branch are preserved until then; work happens on branch `mobimeet-ai`.
* Public OSRM demo = development only; nothing paid is ever selected or activated automatically; deterministic fallbacks exist for every optional service.

## Run locally (no accounts needed)
```bash
npm install
npm run dev:full        # http://localhost:3000/app/   (classic planner at /)
npm run check           # ESLint + static verification + all tests
npm run build           # → dist/
```
`dev:full` uses an embedded PostgreSQL (stored in `.data/`, git-ignored) and the public OSRM demo for Bike mode (development only). Private settings go in a local `.env` (copy names from `.env.example`). `npm run env:check -- preview|production` lists what is set or missing, by name only. `node scripts/llm-check.mjs --test` checks the AI key (use plain `node`: a package-manager wrapper on a work laptop can break TLS for network calls).

## Environment variables
| Variable | Needed for | Notes |
|---|---|---|
| `DATABASE_URL` | preview + production | Neon **pooled** connection string |
| `DATABASE_URL_UNPOOLED` | migrations | Neon **direct** string, used by `npm run db:migrate` |
| `ROUTING_MODE=estimate` | Bike in production until a provider exists | free; every Bike plan is labelled an estimate |
| `ROUTING_PROVIDER_URL` (+ `ROUTING_PROFILE`, `ROUTING_MIN_INTERVAL_MS`, `ROUTING_API_KEY`, `ROUTING_API_KEY_HEADER`) | real Bike routing | any OSRM-compatible server; the public demo is refused on https hosts (`ALLOW_PUBLIC_OSRM_IN_PRODUCTION` stays `false`) |
| `CRON_SECRET` | production | long random string authorising the daily clean-up job |
| `GROQ_API_KEY`, `GROQ_MODEL` (or Anthropic / OpenAI keys, `LLM_PROVIDER`) | optional AI | everything works without them |
| `LLM_MAX_PER_MINUTE`, `LLM_MAX_PER_DAY`, `LLM_MAX_TOKENS_PER_MINUTE`, `LLM_MAX_TOKENS_PER_DAY`, `LLM_MAX_PER_USER_10MIN`, `LLM_MAX_PER_GROUP_HOUR` | optional | model-call budgets, see "AI usage and cost" |
| `MAIL_MODE=resend`, `RESEND_API_KEY`, `MAIL_FROM` | optional real email | off unless all are set |
| `VENUE_RADIUS_KM`, `OVERPASS_URL` | optional | venue search radius (0.5–5 km) and endpoint |
| `APP_BASE_URL` | – | leave empty on Vercel (derived); a wrong value causes "Cross-site requests are not allowed" |
| `AUTO_MIGRATE` | – | keep `false`; run `npm run db:migrate` |
| `TEST_DATABASE_URL` | `npm run test:pg` only | a **disposable** database/branch — its schema is wiped |

## Database (Neon)
* **Plan:** Neon Free is permanent and needs no card: 1 GB storage and 100 compute-hours per project per month, 10 branches, compute scales to zero after 5 idle minutes (the first request after a quiet period is slower); at its limits it stops writes/compute rather than billing (Neon pricing page, 2026-11-13 — re-check).
* **Layout:** a personal Neon project; branch `production` holds the app (migrations 001–003 applied); a separate `test` branch is the disposable test database.
* **Connections:** the app (`api/index.js`) uses the **pooled** string (`DATABASE_URL`, PgBouncer transaction mode) with at most 3 connections per function instance, 10 s idle/connect timeouts and a 30 s statement timeout; schema changes use the **direct** string. Transactions, bound parameters, `FOR UPDATE` row locks and rollback were exercised through the pooled endpoint.
* **TLS:** `src/db/client.js` upgrades any remote `sslmode=require/prefer/verify-ca` (or none) to `verify-full`; verified: client↔server TLS 1.3 with a validated certificate on both endpoints, and a plaintext attempt (`sslmode=disable`) is refused by Neon. Local hosts are left alone.
* **Secrets handling:** connection strings exist only in `.env` / Vercel settings; scripts print host and database names only; error messages and logs never contain them.
* **Migrate:** `npm run db:migrate` (idempotent). **Test on real PostgreSQL:** put the `test` branch's direct string in `TEST_DATABASE_URL`, then `npm run test:pg` — it refuses to run if that string points at the same database as `DATABASE_URL`, or if the variable is missing. UI tests wait longer automatically against a remote database; assertions are unchanged.

### Neon test-run record (PostgreSQL 18.7, Neon `test` branch, region ap-southeast-1)
See "Verification record" at the end of this page.

## AI usage and cost
* **Design:** rules understand almost every agent message; the model is only a fallback for text the rules cannot parse, for open plan questions, for suggesting preferences from a note, and for optional re-wording. It can never change routes, plans, permissions or memberships (tests: `llm-boundaries.test.js`). Group size does not change the cost.
* **Measured on Groq `openai/gpt-oss-20b` (real calls):**

  | Feature | avg input tokens | avg output tokens | cost per call at $0.075 / $0.30 per million |
  |---|---|---|---|
  | Agent classification | 240 | 48 | ≈ $0.00003 |
  | Plan chat (open question) | 1,109 | 155 | ≈ $0.00013 |
  | Parse a travel note | 170 | 121 | ≈ $0.00005 |
  | Re-word an explanation (cached per plan) | 576 | 217 | ≈ $0.00011 |

  Prices are from Groq's model page for `openai/gpt-oss-20b` ($0.075 input, $0.0375 cached input, $0.30 output per million tokens); re-check before relying on them.
* **Provider limits (Groq docs for this model; may be the Developer plan's base limits — confirm yours in the Groq console):** 30 requests/min, 1,000 requests/day, 8,000 tokens/min, 200,000 tokens/day; exceeding a limit returns HTTP 429 with `retry-after`.
* **Protections (all shared across instances through the database, all configurable):**

  | Protection | Default | Env var |
  |---|---|---|
  | requests per minute, all users | 10 | `LLM_MAX_PER_MINUTE` |
  | requests per day (UTC), all users | 300 | `LLM_MAX_PER_DAY` |
  | estimated tokens per minute | 6,000 | `LLM_MAX_TOKENS_PER_MINUTE` |
  | estimated tokens per day (UTC) | 150,000 | `LLM_MAX_TOKENS_PER_DAY` |
  | requests per person per 10 min | 12 | `LLM_MAX_PER_USER_10MIN` |
  | requests per group per hour | 60 | `LLM_MAX_PER_GROUP_HOUR` |

  Each call first reserves its request slots and a conservative token estimate (agent 700, notes 700, re-word 1,000, chat 1,600); a refused reservation uses nothing up and the caller answers deterministically. After a provider 429 the app stops calling it for the `retry-after` period. Plain question types (plan questions) never reach the model. Existing per-user limits on chat/notes/re-wording (20 per 10 minutes) also apply.
* **Normal use:** ~5 model calls per active user per day × ≈ $0.00008 average → well under $0.01 per day for hundreds of users; on Groq's free tier it costs nothing.
* **Worst case at the defaults:** the token cap bounds spend regardless of traffic: 150,000 tokens/day ≈ at most $0.02/day (≈ $0.60/month) at the prices above, and the request caps keep the app below the free limits (10/min vs 30; 300/day vs 1,000; 6,000 vs 8,000 tokens/min; 150,000 vs 200,000 tokens/day). Estimates are reservations, not metered usage; a few unusually long answers could still reach the provider's own limit, which the 429 back-off absorbs. When any budget is used up the app answers without the model — nothing errors. On a paid plan raise the `LLM_MAX_*` values.

## Bike routing (production) — which options are genuinely two-wheeler?
The app needs a two-way matrix of road distances/times (≈ 40 candidates × participants) and route geometry. Evidence below is from provider documentation (2026-11-13) and public demo calls; **no paid API was called or activated**.

| Option | Real motorcycle/two-wheeler support? | Evidence | Coverage / limits | Cost (indicative) | Verdict |
|---|---|---|---|---|---|
| `ROUTING_MODE=estimate` (built in) | no — straight-line × 1.35 at 25 km/h | our code | everywhere | free | use for the first preview; labelled as estimates |
| **OSRM** (public demo or self-hosted) | **no** — bundled profiles are `car`, `bicycle`, `foot` (a custom Lua profile would be your own work) | OSRM repo `profiles/` listing; demo returned car routes (8.97 km / 12.8 min for a test pair) | any OSM extract you process; public demo is shared, fair-use, dev-only | software free; VM with ≥ 8 GB RAM ≈ US$10–25/month (unverified) | car approximation, cheapest real option; no code change |
| **Valhalla** (self-hosted) | **yes** — `motorcycle` costing (marked BETA) and `motor_scooter`, with their own options (`use_highways`, `use_trails`, `use_curvature`) | Valhalla API reference; live demo call: default `motorcycle` equalled `auto` on a test pair (35.1 km), but `use_highways=0` changed it to 37.0 km / 105 min, so it is a separate cost model, not a renamed car profile | OSM; no live traffic; memory estimates vary widely (4–16 GB); India extract size/time not measured | software free + VM | best genuine two-wheeler option; needs a new provider adapter (≈ 80 lines + tests, not written) |
| **Google Routes API** (`TWO_WHEELER`) | **yes** — documented for two-wheeled motorised vehicles; beta; a warning must be shown with each route | Google "two-wheel route" docs; matrix supports two-wheeler (bicycling excluded); ≤ 50 origins+destinations and ≤ 625 elements per request | country list is on a separate Google page and **India was not confirmed**; billed at a higher rate than driving | needs billing account/card; standard matrix ≈ US$5 per 1,000 elements (higher for two-wheeler/traffic) | most accurate, but paid; adapter not written |
| **HERE Routing v8** (`scooter`) | **yes** — two-wheeler mode on roads open to motorcycles; 60 km/h cap and no highways by default (`allowHighway` overrides) | HERE routing docs | India coverage, pricing and matrix terms **not verified** | free tier exists (not verified) | candidate; needs adapter and verification |
| **TomTom** (`motorcycle`) | **beta** | TomTom routing docs: bus, motorcycle, taxi, van are BETA; restriction data not available everywhere | India listed by a third party only; matrix: ~2.5k free async cells | free allowance figures conflict between sources | candidate; needs verification |
| **GraphHopper** hosted | free package: car, bike, foot only; `motorcycle` **on request** | GraphHopper docs/pricing | free plan: 500 credits/day, 5 locations/request, non-commercial | from ≈ €69/month | free plan too small |
| **OpenRouteService** | **no** — driving-car, HGV, cycling, walking, wheelchair | HeiGIT docs/third-party summaries | quotas reported inconsistently; public host reported to retire after 2 Nov 2026 (unconfirmed) | free/paid tiers | not recommended |
| **Mapbox** | **no** — driving, walking, cycling | (not re-checked this session) | – | per element | not suitable |
| **Ola Maps / Mappls** | not confirmed (two-wheeler on Ola's roadmap per third-party notes) | third-party summaries only | India-focused | Ola: first 100k calls/API/month free (conflicting sources); Mappls: sales-gated | verify with the vendor first |

**Recommendation (nothing activated):** (1) first preview: `ROUTING_MODE=estimate`; (2) first real routing: self-hosted OSRM with the car profile on a small VM (cheapest; label results "driving profile"); (3) if true motorcycle routing matters: a self-hosted **Valhalla** with `motorcycle` costing — free software, a VM you pay for, and an adapter I would write and test after your approval — or Google Routes `TWO_WHEELER` if you accept a paid, card-backed service (set a hard budget alert first). The provider interface (`route`, `matrix`) and the production safety guard (public demo refused on https hosts, disabled provider fails loudly) are unchanged.

## Email
Development: an in-memory outbox (nothing sent). Production: password reset reports "not available" until `MAIL_MODE=resend` with `RESEND_API_KEY` and a `MAIL_FROM` on a domain verified in Resend. The adapter is tested with a mock only. Resend's free plan (3,000 emails/month, 100/day, 3 domains) delivers only to your own account address until a domain is verified (a few DNS records; a domain costs money — your decision). Brevo's free plan (≈ 300/day) needs a separate adapter and its single-sender rules were not confirmed. App-password SMTP is not recommended for a public app. A message is never reported as sent unless the provider answered 2xx.

## Costs summary (nothing is switched on)
| Item | Default | When money could be involved |
|---|---|---|
| Vercel Hobby | free | exceeding its limits pauses features rather than charging (check your plan) |
| Neon Free | free | only if you upgrade |
| Routing `estimate` | free | – |
| OpenStreetMap lookups (venues, address search) | free public services | heavy use can be rate-limited, not billed |
| Groq | free tier, no card | only if you add a payment method; set a spending limit first; the app caps usage (above) |
| Email | off | a domain (yearly) if you want real reset emails |
| Production routing server | not provisioned | a VM, roughly US$10–25/month, if you choose OSRM/Valhalla |

## Vercel
* The existing production site (`https://metromeet-ai.vercel.app`, the static build of the original planner; its page title is still "MetroMeet AI", `/api/health` and `/sw.js` return 404) stays on `main` and is **not changed by a preview deployment**. The original site needed no environment variables, so the Vercel project currently has none of those listed above — add them yourself (Project → Settings → Environment Variables, **Preview** scope first). The local folder is not linked to a Vercel project and the Vercel CLI is not required.
* `vercel.json`: build `npm run build` → `dist/`, one function `api/index.js` behind `/api/*`, daily cron `/api/maintenance` (needs `CRON_SECRET`), security headers (nosniff, frame deny, strict referrer, HSTS, permissions policy) and a strict CSP on `/app/*`. The build command and output directory of the original deployment are preserved (test-enforced).
* **Preview first:** pushing the `mobimeet-ai` branch makes Vercel build a preview URL such as `metromeet-ai-git-mobimeet-ai-….vercel.app`; production stays on `main` until you promote or merge.

### Smoke checklist (preview)
`/api/health` → register → choose Metro or Bike → create a group with names → open the invitation link in a second browser profile and claim a name → optimise → each participant tells their own agent an update → the others see it → confirm the plan → sign out → open the app offline (shell and saved plan) → DevTools → Application → Service Workers → delete the test account.

## If something goes wrong
| Symptom | Likely cause | Fix |
|---|---|---|
| `npm run env:check` shows ✘ | a variable is missing | add it as listed above |
| `/api/...` shows "Service unavailable" | `DATABASE_URL` missing or wrong | fix it in Vercel and redeploy |
| Sign-in works locally but fails on the preview with "Cross-site requests are not allowed" | `APP_BASE_URL` set to the wrong site | remove it (automatic on Vercel) |
| Bike plan says "Bike routing needs a production routing provider" | no routing choice in production | set `ROUTING_MODE=estimate` |
| AI answers never appear | key missing/typo, provider mismatch, budget used up, or the provider's limit/spending cap | `npm run env:check`; `node scripts/llm-check.mjs --test`; provider dashboard |
| First request after a quiet period is slow | Neon wakes from idle | normal on the free plan |
| Database stops accepting writes | free storage/compute used up for the month | clean up or upgrade; reads continue |
| `npm run llm:check` fails with a certificate error | the work-laptop package manager intercepts TLS | run `node scripts/llm-check.mjs` directly |

## Outstanding items
**Needed from you before a Vercel preview:** (1) your commit name and GitHub no-reply email, and approval to commit (local) — then separate approval to push `mobimeet-ai`; (2) set the Preview environment variables in Vercel (`DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `ROUTING_MODE=estimate`; optionally `GROQ_API_KEY`/`GROQ_MODEL` and the `LLM_MAX_*` values); (3) after the preview builds: run the smoke checklist and open the app once in your own Chrome (Service Workers panel).
**Decisions for you:** production Bike routing (estimate vs own OSRM vs Valhalla vs a paid API); whether and when to buy a domain for real email; whether to raise the Groq limits (paid plan); whether to promote the preview to production.
**Human checks I cannot do:** BMRCL verification of station order, interchanges, Pink Line dates and fares; live venue lookups once Overpass is reachable; a service-worker check in your own browser; a read of the Vercel dashboard (no access from here).
**Final gates (nothing done):** approval to commit · approval to push (preview) · approval to promote to production.
**Resolved decisions:** Public OSRM = development only (refused in production by code) · deterministic fallbacks everywhere · production routing starts as explicit `estimate` mode, never a silent paid service · Vercel (hosting, functions, cron) + GitHub (CI) + Neon (database) + OpenStreetMap public services — no additional paid service is required · Groq is the AI provider · Neon is the database (SQLite was considered and rejected: no persistent disk on Vercel and a rewrite of the Postgres-specific data layer).

## Verification record (2026-11-13)
**Neon (real PostgreSQL), disposable `test` branch — `npm run test:pg`:**
* Database: `PostgreSQL 18.7 (a21afb5) on aarch64-unknown-linux-gnu` (Neon, region ap-southeast-1), reached over TLS 1.3 with a verified certificate, direct endpoint (the pooled endpoint was exercised separately: transactions, bound parameters, `FOR UPDATE`, rollback).
* Migrations on both branches: `001_init`, `002_password_resets`, `003_participants_agents_events` — 17 tables. The app branch (`production`) has 0 rows; only the `test` branch is ever written to by tests.
* **Final run (on the final tree, with the full per-test report saved and compared name-by-name with the local run): 298 tests in 31 files, 298 passed, 0 failed, 0 skipped; duration 1,082 s (18.0 min).** Earlier runs on the same branch: 277/292 (15 UI failures from a 4-second wait that is too short for a remote database — fixed by scaling the wait when `TEST_DATABASE_URL` is set, assertions unchanged) and 297/298 (a timing race in one UI test, now waited for; it also exposed a real defect — an older page load writing into a newer page and duplicating cards — fixed in `app/views/group.js`).
* What this does and does not prove: compatibility with Neon's PostgreSQL 18.7 through the `pg` driver (migrations, constraints, partial unique indexes, triggers, transactions, row locks, JSONB, serial counters, the rate-limit upserts used for budgets). It says nothing about other PostgreSQL versions or providers, other regions, sustained load, or Neon's behaviour after a free-plan limit is reached.
* The same suite on the embedded database: 298/298 (`npm run check`, with lint and the static verifier).

**Other checks:** `npm run build` passes; the original planner's 36 built-in diagnostics passed on a debug build; live Groq key check and live workflows passed; real-browser checks on desktop and 375 px (sign-up, group and invitation flows, Bike plan with road routes, agent updates, password reset, service-worker registration); live HTTP authorisation checks (signed-out 401, non-member 404 on nine group actions, forged cross-site POST 403, invalid mode 400).
