-- Applied to project jkpctgapbsyzqjfiiuoe on 2026-10-18 (via Supabase MCP).
create extension if not exists http with schema extensions;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

-- Shared, sport-agnostic research backbone. NHL writes here first; MLB/NFL/NBA migrate onto it.
create table public.events (
  sport text not null, event_id text not null, start_time timestamptz, season text, game_type text,
  home text, away text, home_name text, away_name text, status text, home_score int, away_score int,
  odds_event_id text, final boolean not null default false, updated_at timestamptz not null default now(),
  primary key (sport, event_id)
);
create table public.quotes (
  id bigserial primary key, sport text not null, event_id text not null, snapshot_kind text not null,
  captured_at timestamptz not null default now(), book text not null, market text not null,
  player_id text, player_name text, line numeric, over_price int, under_price int, book_updated_at timestamptz,
  foreign key (sport, event_id) references public.events (sport, event_id)
);
create index quotes_event_idx on public.quotes (sport, event_id, snapshot_kind);
create index quotes_player_idx on public.quotes (sport, player_id, market);
create table public.predictions (
  id bigserial primary key, sport text not null, event_id text not null, player_id text not null,
  player_name text, team text, market text not null, line numeric not null, model_version text not null,
  snapshot_kind text not null, created_at timestamptz not null default now(), proj numeric, dist text,
  p_over numeric, p_under numeric, p_push numeric, inputs jsonb,
  unique (sport, event_id, player_id, market, line, model_version, snapshot_kind),
  foreign key (sport, event_id) references public.events (sport, event_id)
);
create index predictions_event_idx on public.predictions (sport, event_id);
create table public.outcomes (
  sport text not null, event_id text not null, player_id text not null, stat text not null, value numeric,
  participated boolean not null default true, source text, recorded_at timestamptz not null default now(),
  primary key (sport, event_id, player_id, stat),
  foreign key (sport, event_id) references public.events (sport, event_id)
);
create table public.collector_runs (
  id bigserial primary key, sport text not null, job text not null, started_at timestamptz not null default now(),
  finished_at timestamptz, credits_used int default 0, credits_remaining int, notes jsonb, error text
);
create index collector_runs_month_idx on public.collector_runs (sport, started_at);

alter table public.events enable row level security;
alter table public.quotes enable row level security;
alter table public.predictions enable row level security;
alter table public.outcomes enable row level security;
alter table public.collector_runs enable row level security;
create policy "public read" on public.events for select to anon, authenticated using (true);
create policy "public read" on public.quotes for select to anon, authenticated using (true);
create policy "public read" on public.predictions for select to anon, authenticated using (true);
create policy "public read" on public.outcomes for select to anon, authenticated using (true);
create policy "public read" on public.collector_runs for select to anon, authenticated using (true);

select vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'collector_token', 'Shared secret for scheduled collector calls');
create or replace function public.check_collector_token(t text) returns boolean
language sql security definer set search_path = '' as $$
  select exists (select 1 from vault.decrypted_secrets where name = 'collector_token' and decrypted_secret = t);
$$;
revoke all on function public.check_collector_token(text) from public, anon, authenticated;
grant execute on function public.check_collector_token(text) to service_role;
