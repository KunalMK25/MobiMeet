// ═══════════════════════════════════════════════════════════
//  db/migrations.js — ordered, append-only PostgreSQL migrations.
//  Never edit a shipped migration; add a new one. Applied by db/migrate.js.
//
//  Design notes (see docs/ARCHITECTURE.md §Data):
//   • groups.mode is immutable (trigger) and memberships carry a copy of it
//     enforced by a composite FK → a mixed-mode membership cannot exist.
//   • Invitation tokens and session tokens are stored only as SHA-256 hashes.
//   • Plans are append-only versions; confirmed plans are never overwritten.
//     Per-participant routes / candidate metrics live inside plans.result (jsonb)
//     instead of separate tables: they are only ever read with their plan.
//   • audit_events never stores coordinates.
// ═══════════════════════════════════════════════════════════
export const MIGRATIONS = [
  {
    id: '001_init',
    sql: `
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  display_name  text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 60),
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email));

CREATE TABLE user_profiles (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  default_prefs  jsonb NOT NULL DEFAULT '{}'::jsonb,
  saved_places   jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE groups (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id          uuid NOT NULL REFERENCES users(id),
  name              text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  description       text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  mode              text NOT NULL CHECK (mode IN ('METRO','BIKE')),
  status            text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','open','optimizing','proposed','confirmed','cancelled','expired')),
  objective         jsonb NOT NULL DEFAULT '{}'::jsonb,
  selected_plan_id  uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, mode)
);
CREATE INDEX groups_owner_idx ON groups (owner_id);

CREATE FUNCTION groups_mode_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.mode IS DISTINCT FROM OLD.mode THEN
    RAISE EXCEPTION 'groups.mode is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER groups_mode_immutable_trg BEFORE UPDATE ON groups
  FOR EACH ROW EXECUTE FUNCTION groups_mode_immutable();

CREATE TABLE group_memberships (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id         uuid NOT NULL,
  transport_mode   text NOT NULL,
  user_id          uuid NOT NULL REFERENCES users(id),
  role             text NOT NULL CHECK (role IN ('owner','member')),
  join_status      text NOT NULL DEFAULT 'joined' CHECK (join_status IN ('joined','left','removed')),
  origin_lat       double precision CHECK (origin_lat BETWEEN -90 AND 90),
  origin_lon       double precision CHECK (origin_lon BETWEEN -180 AND 180),
  origin_station_id text,
  origin_label     text CHECK (char_length(origin_label) <= 120),
  soft_prefs       jsonb NOT NULL DEFAULT '{}'::jsonb,
  hard_constraints jsonb NOT NULL DEFAULT '{}'::jsonb,
  agent_snapshot   jsonb,
  agent_version    integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id, user_id),
  FOREIGN KEY (group_id, transport_mode) REFERENCES groups (id, mode) ON DELETE CASCADE,
  CHECK ((origin_lat IS NULL) = (origin_lon IS NULL))
);
CREATE INDEX memberships_user_idx ON group_memberships (user_id);

CREATE TABLE group_invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  created_by  uuid NOT NULL REFERENCES users(id),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  max_uses    integer NOT NULL DEFAULT 5 CHECK (max_uses BETWEEN 1 AND 50),
  uses        integer NOT NULL DEFAULT 0 CHECK (uses >= 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invitations_group_idx ON group_invitations (group_id);

CREATE TABLE optimization_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id     uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES users(id),
  strategy     text NOT NULL,
  input_hash   text NOT NULL,
  status       text NOT NULL CHECK (status IN ('running','succeeded','failed')),
  error_code   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);

CREATE TABLE meetup_plans (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id         uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  request_id       uuid REFERENCES optimization_requests(id),
  version          integer NOT NULL CHECK (version >= 1),
  status           text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','confirmed','superseded')),
  strategy         text NOT NULL,
  input_hash       text NOT NULL,
  result           jsonb NOT NULL,
  created_by       uuid NOT NULL REFERENCES users(id),
  confirmed_by     uuid REFERENCES users(id),
  confirmed_at     timestamptz,
  supersedes_plan_id uuid REFERENCES meetup_plans(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id, version)
);
ALTER TABLE groups ADD CONSTRAINT groups_selected_plan_fk FOREIGN KEY (selected_plan_id) REFERENCES meetup_plans(id);

CREATE TABLE plan_venues (
  plan_id     uuid PRIMARY KEY REFERENCES meetup_plans(id) ON DELETE CASCADE,
  source      text NOT NULL,
  is_fallback boolean NOT NULL DEFAULT false,
  venues      jsonb NOT NULL,
  fetched_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE what_if_scenarios (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  created_by  uuid NOT NULL REFERENCES users(id),
  base_plan_id uuid REFERENCES meetup_plans(id),
  definition  jsonb NOT NULL,
  result      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
  id          bigserial PRIMARY KEY,
  actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  group_id    uuid,
  event_type  text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_group_idx ON audit_events (group_id);

CREATE TABLE rate_limits (
  key          text NOT NULL,
  window_start timestamptz NOT NULL,
  count        integer NOT NULL,
  PRIMARY KEY (key, window_start)
);
`,
  },
  {
    id: '002_password_resets',
    sql: `
CREATE TABLE password_resets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);
CREATE INDEX password_resets_user_idx ON password_resets (user_id);
`,
  },
  {
    id: '003_participants_agents_events',
    sql: `
-- One row per participant seat in a group. Pre-named seats (entered by the creator) can be claimed exactly once by an
-- authenticated account. The row also holds the PUBLISHED state of that participant's personal agent.
CREATE TABLE group_participants (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ord            bigserial NOT NULL,
  group_id       uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name           text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  name_key       text NOT NULL,
  pre_named      boolean NOT NULL DEFAULT false,
  user_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  claimed_at     timestamptz,
  travel_status  text NOT NULL DEFAULT 'invited' CHECK (travel_status IN ('invited','planning','en_route','at_station','arrived','withdrawn')),
  delay_minutes  integer NOT NULL DEFAULT 0 CHECK (delay_minutes BETWEEN 0 AND 240),
  share          jsonb NOT NULL DEFAULT '{"delays":true,"arrival":true,"location":true}'::jsonb,
  pending_action jsonb,
  delivered_seq  bigint NOT NULL DEFAULT 0,
  acked_seq      bigint NOT NULL DEFAULT 0,
  agent_updated_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id, name_key)
);
-- A seat can be held by one account and an account can hold one seat per group (the claim race is decided here).
CREATE UNIQUE INDEX group_participants_user_uq ON group_participants (group_id, user_id) WHERE user_id IS NOT NULL;

-- Shared coordination layer: append-only. 'group' events are visible to every member; 'internal' events are coordinator data only.
CREATE TABLE group_events (
  seq            bigserial PRIMARY KEY,
  group_id       uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  participant_id uuid REFERENCES group_participants(id) ON DELETE SET NULL,
  type           text NOT NULL,
  visibility     text NOT NULL CHECK (visibility IN ('group','internal')),
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX group_events_group_idx ON group_events (group_id, seq);

-- PRIVATE conversation between one participant and their own agent. Never joined into any group-facing query.
CREATE TABLE agent_messages (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id       uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL REFERENCES group_participants(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role           text NOT NULL CHECK (role IN ('user','agent')),
  body           text NOT NULL CHECK (char_length(body) <= 1000),
  intent         text,
  event_seq      bigint,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_messages_owner_idx ON agent_messages (participant_id, created_at);
`,
  },
];
