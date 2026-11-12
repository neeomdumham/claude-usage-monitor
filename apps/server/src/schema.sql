-- Idempotent schema; applied on every server start.
-- ponytail: no migration tool; add one when a change can't be expressed as "if not exists".

-- A teammate. Invites and devices hang off a person; the dashboard ranks people.
create table if not exists people (
  id bigserial primary key,
  name text not null,
  created_at timestamptz not null default now()
);

-- Replaced by invites (2026-11-12); dropping is a no-op once gone.
drop table if exists invitations;

-- Pre-approved invite: creating it is the owner's approval. Redeemed atomically up to max_uses.
create table if not exists invites (
  id bigserial primary key,
  secret_hash text unique not null,          -- sha256 of the whole ccm_inv_ token
  person_id bigint not null references people(id),
  max_uses int not null default 2,
  uses int not null default 0,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists installations (
  id bigserial primary key,
  name text not null,
  token_hash text unique not null,          -- sha256 of the monitoring credential
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_heartbeat_at timestamptz,
  applied_policy_revision int,
  capabilities jsonb not null default '{}',
  client_version text,
  queue_depth int not null default 0,
  dropped_count int not null default 0
);
alter table installations
  add column if not exists person_id bigint references people(id),  -- null only for pre-invite enrollments
  add column if not exists hostname text,
  add column if not exists os text,
  add column if not exists joined_ip text;

create table if not exists credentials (
  id bigserial primary key,
  fingerprint text unique not null check (fingerprint ~ '^[0-9a-f]{64}$'), -- sha256 of setup token
  label text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists credential_bindings (
  installation_id bigint not null references installations(id),
  credential_id bigint not null references credentials(id),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (installation_id, credential_id)
);

create table if not exists usage_events (
  id bigserial primary key,
  source_event_id text unique not null,     -- dedupe key for retried deliveries
  installation_id bigint not null references installations(id),
  credential_id bigint references credentials(id), -- null = unknown-auth bucket
  session_id text,
  prompt_id text,
  request_id text,
  agent_id text,
  parent_agent_id text,
  model text not null,
  event_time timestamptz not null,          -- original time; windows use this, never received_at
  received_at timestamptz not null default now(),
  input_tokens bigint not null,
  output_tokens bigint not null,
  cache_read_tokens bigint not null,
  cache_creation_tokens bigint not null,
  cost_usd numeric(12,6),
  duration_ms int
);
create index if not exists usage_events_event_time on usage_events (event_time);
alter table usage_events
  add column if not exists query_source text,
  add column if not exists effort text,
  add column if not exists speed text,
  add column if not exists repo text,
  add column if not exists entrypoint text;

-- Content-free activity (tool names, decisions, compactions, ...). attrs holds only allowlisted keys.
create table if not exists activity_events (
  id bigserial primary key,
  source_event_id text unique not null,
  installation_id bigint not null references installations(id),
  session_id text,
  event_name text not null,
  event_time timestamptz not null,
  repo text,
  attrs jsonb not null default '{}',
  received_at timestamptz not null default now()
);
create index if not exists activity_events_event_time on activity_events (event_time);

-- Written by the plugin's SessionStart hook; resolves credentials for events at query time,
-- so a binding that arrives after its first telemetry batch still attributes correctly.
create table if not exists session_bindings (
  session_id text primary key,
  installation_id bigint not null references installations(id),
  credential_id bigint references credentials(id), -- null = device stands in for the credential
  created_at timestamptz not null default now()
);

-- One row per distinct account state; repeat observations only extend last_observed_at.
create table if not exists quota_snapshots (
  id bigserial primary key,
  meter_key text not null,
  label text,
  used_percentage numeric(5,2) not null,
  resets_at timestamptz not null,
  first_observed_at timestamptz not null,
  last_observed_at timestamptz not null,
  received_at timestamptz not null default now(),
  source text not null,
  observer_installation_id bigint references installations(id),
  unique (meter_key, resets_at, used_percentage)
);

-- Every revision is kept; the table doubles as the policy audit log.
create table if not exists policies (
  revision serial primary key,
  data jsonb not null,
  created_at timestamptz not null default now()
);
