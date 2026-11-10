# WDSF İstanbul 2026 · Competition schedule

Mobile schedule for the WDSF World Championships & Istanbul Global Open (11–15 Nov 2026).
The page is checked every 5 minutes during the event (`loop.yml`, a long-running job that hands over to a new one) and republished when the data changes from the public WDSF event pages and
published on Cloudflare Pages as a public page (not indexed by search engines).

- `scripts/scrape.mjs` – reads schedule, rounds, entries, team members and rankings from worlddancesport.org
- `scripts/update.mjs` – builds the page from `assets/template.html`
- `.github/workflows/loop.yml` – live updater during the event
- `.github/workflows/update.yml` – one-off and daily updates

## Club pages

`club/<slug>.json` adds a club page at `/<slug>/` (e.g. `/tarz/`). The club's entries are worked out from WDSF data on every build (`scripts/club.mjs`); `notes` holds the coaches' own items.
