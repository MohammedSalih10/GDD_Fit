# November Fitness Challenge

Internal fitness tracker for the GDD Fitness Program (30 min/day, at least 5 days a week, Mon-Sun). Python 3.9+ standard library only; SQLite storage; no install step.

## Run
    python server.py          (or double-click start.bat)

Open http://localhost:8000. Teammates on the same network use http://<this-pc-ip>:8000 (allow Python through Windows Firewall if prompted).
Members sign in with their email address. First run creates the coordinator account (sign in as `admin`) and prints its password in the console. Forgot a password: `python server.py set-password <email>` (or `admin`).
Older databases keyed on employee ID are migrated automatically on start (the `emp_id` column becomes `email`).

Env vars: `GDD_PORT` (8000), `GDD_HOST` (0.0.0.0), `GDD_TZ_OFFSET_HOURS` (5.5), `GDD_SECURE_COOKIE=1` (when served over HTTPS), `GDD_ROOT_EMAIL` (admin; login of the built-in Admin, must match the stored account if the DB already exists).

## Rules implemented (from the enrolment form)
- A day counts at >= 30 min total; each entry >= 15 min (one 30 or two 15s). Extra time can be logged.
- Open all 7 days (Mon-Sun). Members can log today and the previous 4 days (`LOG_BACK_DAYS` in server.py). Older dates go to the admin as a request with a reason (Requests tab: approve adds the entry, reject discards it).
- Weekly goal: 5 days out of Mon-Sun (`WEEK_GOAL`). Celebration pop-ups: first-ever log; every perfect week (5+ days met). Once each.
- Streak = consecutive days met; an unlogged Sat/Sun or an excused day neither counts nor breaks it; a missed weekday resets it.
- Fine report: fewer than 3 days done in a Mon-Sun week = Rs 50 (`MIN_DAYS`, `FINE_PER_WEEK`; Fine report tab, CSV export). Each excused day lowers the 3 required days by one (3+ excused days = no fine for that week). Fines are generated only after Sunday has left the 4-day logging window (from the Friday after the week ends), so Sunday's activity can still be logged first. The week containing the programme start (partial) is never fined. The Rs 100 false-entry fine is manual.
- Leave: any participating member can apply (My profile > Apply for leave: date range + reason, up to 62 days, max 5 pending). A coordinator or the Admin approves/rejects it in the Requests tab; approval marks each day as excused exactly like the Leave tab. Members can cancel while pending. Coordinators can still mark leave directly.
- Ranking score = current streak days × 120 min (`STREAK_DAY_MINUTES`) + minutes logged in the selected period (week/month); ties share a rank.
- Leaderboard shows aggregates (week/month). Clicking a ranked member's name opens a pop-up with their current-week activities (activity, minutes, date); notes, timestamps and older weeks are not exposed to other members.

## Moving to a server
Copy the folder, keep `data/gdd_fit.db` (all data lives there), run `python server.py`. Put it behind HTTPS and set `GDD_SECURE_COOKIE=1`. Back up the `data/` folder.

## Layout
- `server.py` - API, auth, rules, static file server
- `static/` - single-page UI (index.html, app.css, app.js); styling follows aarvee.com (navy/Aarvee blue, serif headings)
- `static/fonts/` - self-hosted Golos Text + Playfair Display (OFL, Latin subset); the CSP only allows same-origin fonts
- `data/` - created at runtime (SQLite DB)
