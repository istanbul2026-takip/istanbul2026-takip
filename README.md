# WDSF İstanbul 2026 · Competition schedule

Mobile schedule for the WDSF World Championships & Istanbul Global Open (11–15 Nov 2026).
The page is checked every 5 minutes during the event (`loop.yml`, a long-running job that hands over to a new one) and republished when the data changes from the public WDSF event pages and
published with GitHub Pages. The published page is encrypted; it opens with the access password.

- `scripts/scrape.mjs` – reads schedule, rounds, entries, team members and rankings from worlddancesport.org
- `scripts/update.mjs` – builds the page from `assets/template.html` and encrypts it with the `SITE_PASSWORD` secret
- `.github/workflows/loop.yml` – live updater during the event
- `.github/workflows/update.yml` – one-off and daily updates
