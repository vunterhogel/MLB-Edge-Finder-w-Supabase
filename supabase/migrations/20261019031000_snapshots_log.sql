-- Applied 2026-10-18 via Supabase MCP. One row per game per snapshot kind (dedupe for manual pulls).
create table public.snapshots (
  sport text not null, event_id text not null, kind text not null,
  captured_at timestamptz not null default now(), quotes int, predictions int, credits int,
  primary key (sport, event_id, kind),
  foreign key (sport, event_id) references public.events (sport, event_id)
);
alter table public.snapshots enable row level security;
create policy "public read" on public.snapshots for select to anon, authenticated using (true);
