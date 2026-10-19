-- Applied 2026-10-18 via Supabase MCP. One row per prediction with consensus no-vig, best price per side,
-- latest-snapshot flag, and the graded outcome.
create or replace view public.v_prop_board with (security_invoker = true) as
with q as (
  select sport, event_id, snapshot_kind, player_id, market, line, book, over_price, under_price,
    case when over_price < 0 then -over_price / (-over_price + 100.0) when over_price is not null then 100.0 / (over_price + 100) end as imp_o,
    case when under_price < 0 then -under_price / (-under_price + 100.0) when under_price is not null then 100.0 / (under_price + 100) end as imp_u,
    case when over_price > 0 then 1 + over_price / 100.0 when over_price < 0 then 1 + 100.0 / -over_price end as dec_o,
    case when under_price > 0 then 1 + under_price / 100.0 when under_price < 0 then 1 + 100.0 / -under_price end as dec_u
  from public.quotes where player_id is not null
),
agg as (
  select sport, event_id, snapshot_kind, player_id, market, line,
    count(distinct book) as books,
    count(*) filter (where imp_o is not null and imp_u is not null) as books_2way,
    avg(imp_o / (imp_o + imp_u)) filter (where imp_o is not null and imp_u is not null) as novig_over,
    (array_agg(over_price order by dec_o desc nulls last))[1] as best_over,
    (array_agg(book order by dec_o desc nulls last))[1] as best_over_book,
    (array_agg(under_price order by dec_u desc nulls last))[1] as best_under,
    (array_agg(book order by dec_u desc nulls last))[1] as best_under_book
  from q group by 1,2,3,4,5,6
),
latest as (
  select sport, event_id, case when bool_or(kind = 'close') then 'close' else 'open' end as kind,
    max(captured_at) filter (where kind = 'open') as open_at, max(captured_at) filter (where kind = 'close') as close_at
  from public.snapshots group by 1,2
)
select p.id, p.sport, p.event_id, p.player_id, p.player_name, p.team, p.market, p.line, p.model_version, p.snapshot_kind,
  p.created_at, p.proj, p.p_over, p.p_under, p.p_push, p.inputs,
  e.start_time, e.home, e.away, e.status, e.final,
  (p.snapshot_kind = l.kind) as is_latest,
  a.books, a.books_2way, a.novig_over, a.best_over, a.best_over_book, a.best_under, a.best_under_book,
  m.label as market_label, o.value as actual, o.participated
from public.predictions p
join public.events e on e.sport = p.sport and e.event_id = p.event_id
left join latest l on l.sport = p.sport and l.event_id = p.event_id
left join agg a on a.sport = p.sport and a.event_id = p.event_id and a.snapshot_kind = p.snapshot_kind
  and a.player_id = p.player_id and a.market = p.market and a.line = p.line
left join public.market_stats m on m.sport = p.sport and m.market = p.market
left join public.outcomes o on o.sport = p.sport and o.event_id = p.event_id and o.player_id = p.player_id and o.stat = m.stat;
grant select on public.v_prop_board to anon, authenticated;
