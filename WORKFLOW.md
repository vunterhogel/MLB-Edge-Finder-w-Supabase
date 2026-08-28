# MLB Edge Finder — Dev Workflow

## Stack
- **GitHub** → source of truth (`https://github.com/vunterhogel/MLB-Edge-Finder-w-Supabase`)
- **StackBlitz** → test/edit (`https://stackblitz.com/github/vunterhogel/MLB-Edge-Finder-w-Supabase`)
- **Supabase** → backend (`https://jkpctgapbsyzqjfiiuoe.supabase.co`)

## After Claude makes changes (push to GitHub)

```bash
cd "/Users/huntervogel/Desktop/MLB Edge Finder FULL TESTER (Patched)"
git add .
git commit -m "describe what changed"
git push
```

GitHub will prompt for credentials:
- Username: `vunterhogel`
- Password: your GitHub Personal Access Token (regenerate at GitHub → Settings → Developer settings → PATs)

## After pushing, update StackBlitz
Open `https://stackblitz.com/github/vunterhogel/MLB-Edge-Finder-w-Supabase` to get the latest.

## Supabase edge functions (already deployed — only needed if functions change)

```bash
cd "/Users/huntervogel/Desktop/MLB Edge Finder FULL TESTER (Patched)"
supabase secrets set ODDS_API_KEY=<key>
supabase functions deploy odds-proxy
supabase functions deploy statcast-proxy
```

Supabase dashboard: `https://supabase.com/dashboard/project/jkpctgapbsyzqjfiiuoe`
