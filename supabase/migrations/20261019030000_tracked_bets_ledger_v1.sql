-- Applied 2026-10-18 via Supabase MCP.
-- Writer key: browser sends header x-ef-key; must match the Vault secret 'collector_token'.
create or replace function public.ef_writer_ok() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from vault.decrypted_secrets
    where name = 'collector_token'
      and decrypted_secret = coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-ef-key', '')
  );
$$;
revoke all on function public.ef_writer_ok() from public;
grant execute on function public.ef_writer_ok() to anon, authenticated, service_role;

create table public.tracked_bets (
  id bigserial primary key, sport text not null, event_id text not null, player_id text, player_name text, team text,
  market text not null, line numeric not null, side text not null check (side in ('over','under')), book text,
  odds int not null, units numeric not null default 1, mode text not null default 'paper' check (mode in ('paper','placed')),
  model_version text, snapshot_kind text, proj numeric, model_p numeric, raw_p numeric, novig numeric, ev numeric,
  notes text, created_at timestamptz not null default now(), deleted_at timestamptz,
  foreign key (sport, event_id) references public.events (sport, event_id)
);
create index tracked_bets_sport_idx on public.tracked_bets (sport, created_at desc);
alter table public.tracked_bets enable row level security;
create policy "public read" on public.tracked_bets for select to anon, authenticated using (true);
create policy "writer insert" on public.tracked_bets for insert to anon, authenticated with check (public.ef_writer_ok());
create policy "writer update" on public.tracked_bets for update to anon, authenticated using (public.ef_writer_ok()) with check (public.ef_writer_ok());

create table public.market_stats (sport text not null, market text not null, stat text not null, label text not null, primary key (sport, market));
alter table public.market_stats enable row level security;
create policy "public read" on public.market_stats for select to anon, authenticated using (true);
insert into public.market_stats values
  ('nhl','player_shots_on_goal','sog','Shots on Goal'), ('nhl','player_points','points','Points'), ('nhl','player_total_saves','saves','Saves');

create or replace view public.v_tracked_bets with (security_invoker = true) as
select b.*, e.start_time, e.home, e.away, e.final, o.value as actual, o.participated,
  case
    when b.deleted_at is not null then 'deleted'
    when e.status in ('PPD','CNCL') then 'void'
    when not e.final then 'open'
    when o.value is null or o.participated = false then 'void'
    when o.value = b.line then 'push'
    when (b.side = 'over') = (o.value > b.line) then 'won'
    else 'lost'
  end as status
from public.tracked_bets b
join public.events e on e.sport = b.sport and e.event_id = b.event_id
left join public.market_stats m on m.sport = b.sport and m.market = b.market
left join public.outcomes o on o.sport = b.sport and o.event_id = b.event_id and o.player_id = b.player_id and o.stat = m.stat;
grant select on public.v_tracked_bets to anon, authenticated;
