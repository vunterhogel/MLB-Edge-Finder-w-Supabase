-- Applied to project jkpctgapbsyzqjfiiuoe on 2026-10-18 (via Supabase MCP).
create or replace function public.call_nhl_collector(payload jsonb) returns bigint
language sql security definer set search_path = '' as $$
  select net.http_post(
    url := 'https://jkpctgapbsyzqjfiiuoe.supabase.co/functions/v1/nhl-collector',
    headers := jsonb_build_object('content-type','application/json',
      'x-collector-token', (select decrypted_secret from vault.decrypted_secrets where name = 'collector_token')),
    body := payload, timeout_milliseconds := 120000);
$$;
revoke all on function public.call_nhl_collector(jsonb) from public, anon, authenticated;
select cron.schedule('nhl-open-snapshot', '30 15 * * *', $$select public.call_nhl_collector('{"job":"snapshot","kind":"open"}'::jsonb)$$);
select cron.schedule('nhl-close-snapshot', '*/10 15-23,0-4 * * *', $$select public.call_nhl_collector('{"job":"snapshot","kind":"close"}'::jsonb)$$);
select cron.schedule('nhl-settle', '20 * * * *', $$select public.call_nhl_collector('{"job":"settle"}'::jsonb)$$);
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
