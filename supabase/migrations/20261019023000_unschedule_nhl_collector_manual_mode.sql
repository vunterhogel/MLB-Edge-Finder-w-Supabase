-- Applied 2026-10-18: switch to manual collection for now (user preference).
-- The nhl-collector function stays deployed and only runs when explicitly called
-- (e.g. a manual "pull odds" / "settle" action), for every sport the same way.
select cron.unschedule('nhl-open-snapshot');
select cron.unschedule('nhl-close-snapshot');
select cron.unschedule('nhl-settle');
