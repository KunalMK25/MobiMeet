# Security Policy

## Supported versions

MobiMeet is a single-version, actively developed project. Security fixes
are applied to the `main` branch only.

| Version | Supported |
|---|---|
| 7.x (current, in development) | ✅ |
| < 7.0 | ❌ |

## Scope

MobiMeet has two parts:

1. The original **Quick Metro planner** (`/`) is a static, client-side-only application: no backend, no database, no accounts. Friend names and stations you type stay in the browser tab and are never sent anywhere except as context for an optional AI request.
2. The **MobiMeet app** (`/app/`) has a server-side API (one serverless function) and a PostgreSQL database. It stores accounts (email, display name, salted scrypt password hash), group memberships, starting points and preferences, plans, invitations (token hashes only), private agent conversations, shared structured group events, audit events and rate-limit counters. Security measures:
   * server-side authorisation on every group resource (a non-member cannot tell a group exists: 404), strict input validation, output encoding (no `innerHTML` anywhere in the web app, enforced by a test);
   * opaque session tokens stored only as hashes in an HttpOnly, SameSite cookie (Secure on https); CSRF defence through Origin / `Sec-Fetch-Site` checks; strict Content-Security-Policy and security headers; database-backed rate limits that hold across serverless instances;
   * invitation tokens are random, shown once, stored hashed, expiring, revocable and use-limited; each invited name can be claimed once;
   * private agent conversations are readable only by their owner and are purged after 30 days or with the account; only whitelisted structured facts are published to the group; exact starting points are never shown to other members;
   * secrets live only in environment variables / a git-ignored `.env`; AI keys are server-side only; the AI can never change routes, plans, permissions or memberships;
   * the database connection uses verified TLS; retention and account deletion are implemented (`ARCHITECTURE.md`).

Network calls the apps make: `overpass-api.de` (OpenStreetMap Overpass, nearby places), Nominatim (address search, via the server), an OSRM-compatible routing server (Bike mode, server-side), and — only if you configure a key — the AI provider (Groq, Anthropic or OpenAI, server-side) and the email provider (Resend). Each is optional at runtime and degrades to a labelled fallback (see [`docs/places.md`](docs/places.md) and [`docs/ai.md`](docs/ai.md)).

## Reporting a vulnerability

If you discover a security issue (e.g. an XSS vector in rendered content, a
way to exfiltrate data via the AI context, a dependency vulnerability),
please **do not open a public issue**. Instead:

1. Use GitHub's [private vulnerability reporting](https://github.com/KunalMK25/metromeet-ai/security/advisories/new)
   feature for this repository, **or**
2. Email the maintainer listed in `package.json`'s `author` field.

Please include:
- A description of the issue and its potential impact
- Steps to reproduce
- Any suggested fix, if you have one

We aim to acknowledge reports within 5 business days.

## Dependencies

Runtime: `pg` (PostgreSQL driver) only. Development and tests: `@electric-sql/pglite` (embedded PostgreSQL), `jsdom`, `eslint` (+ `@eslint/js`, `globals`) and `serve`; none of them is shipped to production. Run `npm audit` periodically to check the toolchain.
