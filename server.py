#!/usr/bin/env python3
"""November Fitness Challenge - internal fitness tracker. Standard library only (Python 3.9+).

Run:   python server.py
Other: python server.py set-password <EMAIL>      (reset any account from the console; 'admin' for the first coordinator)
"""
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import sys
import traceback
from datetime import date, datetime, timedelta, timezone
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

BASE = Path(__file__).resolve().parent
STATIC = BASE / "static"
DATA = BASE / "data"
DB_PATH = DATA / "gdd_fit.db"

HOST = os.environ.get("GDD_HOST", "0.0.0.0")
PORT = int(os.environ.get("GDD_PORT", "8000"))
# India has no DST, so a fixed offset avoids needing tzdata on Windows.
TZ = timezone(timedelta(hours=float(os.environ.get("GDD_TZ_OFFSET_HOURS", "5.5"))))
SECURE_COOKIE = os.environ.get("GDD_SECURE_COOKIE") == "1"

DAILY_MIN = 30        # minutes needed for a day to count
SESSION_MIN = 15      # smallest loggable session (two of these make the daily 30)
SESSION_MAX = 300
MAX_ENTRIES_PER_DAY = 8
ROOT_EMAIL = "admin"  # the single built-in Admin; every other is_admin account is a Coordinator
PROGRAM_START = date(2026, 11, 1)  # nothing can be logged before this, for any member
LOG_BACK_DAYS = 4     # calendar days before today that members may still log directly (also the fine grace after Sunday)
REQUEST_REASON_MAX = 200 # why an entry outside the open logging window is late
WEEK_GOAL = 5         # days (any of Mon-Sun) that make a "perfect week" (celebrated)
FINE_PER_WEEK = 50    # rupees, when done days < MIN_DAYS minus excused days in a Mon-Sun week
MIN_DAYS = 3
SESSION_DAYS = 14
HISTORY_WEEKS = 5
EXEMPT_REASONS = ["Illness or injury", "Approved leave", "Official travel / site work",
                  "Family emergency", "Medical advice", "Other"]
EXEMPT_OTHER_MAX = 120  # free-text detail when the reason is "Other"; stored as "Other: <detail>"

# From section 3 of the enrolment form ("Eligible activities").
ACTIVITIES = [
    "Brisk walking", "Jogging / Running", "Cycling", "Gym / Strength training",
    "Yoga", "Swimming", "Sports (outdoor / indoor)", "Aerobics",
    "Dance workout", "Skipping", "Home workout",
    "Cult.Fit", "Badminton", "Pickleball",
]
EMAIL_RE = re.compile(r"^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$")
OTHER_ACTIVITY = "Other"  # member names it; stored as "Other: <name>"
OTHER_MAX = 60

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  participates INTEGER NOT NULL DEFAULT 1,
  created_on TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS exemptions (
  user_id INTEGER NOT NULL REFERENCES users(id),
  ex_date TEXT NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (user_id, ex_date)
);
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  log_date TEXT NOT NULL,
  activity TEXT NOT NULL,
  minutes INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_user_date ON logs(user_id, log_date);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS log_requests (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  log_date TEXT NOT NULL,
  activity TEXT NOT NULL,
  minutes INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT
);
CREATE TABLE IF NOT EXISTS celebrations (
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, kind, key)
);
"""


# ---------------------------------------------------------------- helpers

class ApiError(Exception):
    def __init__(self, status, msg):
        super().__init__(msg)
        self.status, self.msg = status, msg


def now():
    return datetime.now(TZ)


def today():
    return now().date()


def db():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def hash_password(pw, salt=None):
    salt = salt or secrets.token_bytes(16)
    h = hashlib.scrypt(pw.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
    return "scrypt$%s$%s" % (base64.b64encode(salt).decode(), base64.b64encode(h).decode())


def check_password(pw, stored):
    try:
        _, salt, _ = stored.split("$")
        expected = hash_password(pw, base64.b64decode(salt))
    except Exception:
        return False
    return hmac.compare_digest(expected, stored)


def new_password():
    alphabet = "abcdefghjkmnpqrstuvwxyz23456789"  # no look-alikes (i, l, o, 0, 1)
    return "".join(secrets.choice(alphabet) for _ in range(8))


def init_db():
    DATA.mkdir(exist_ok=True)
    conn = db()
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(SCHEMA)
    # Databases from before sign-in by email: the login column was emp_id.
    if "emp_id" in [r[1] for r in conn.execute("PRAGMA table_info(users)")]:
        conn.execute("ALTER TABLE users RENAME COLUMN emp_id TO email")
    if not conn.execute("SELECT 1 FROM users").fetchone():
        pw = new_password()
        conn.execute(
            "INSERT INTO users(email,name,password_hash,is_admin,participates,created_on) VALUES(?,?,?,1,0,?)",
            ("admin", "Admin", hash_password(pw), today().isoformat()))
        conn.commit()
        print("=" * 60)
        print(" First run: admin account created")
        print("   Sign in as : admin")
        print("   Password   : %s" % pw)
        print(" Sign in, add members, and change this password.")
        print("=" * 60)
    conn.commit()
    conn.close()


# ------------------------------------------------- streak / week calculations

def monday_of(d):
    return d - timedelta(days=d.weekday())


def log_open_from(t):
    """Earliest date a member may log directly: the previous LOG_BACK_DAYS days plus today.
    Older dates need an admin-approved request."""
    return t - timedelta(days=LOG_BACK_DAYS)


def day_status(d, minutes, exempt, t, joined):
    if minutes >= DAILY_MIN:
        return "done"
    if d in exempt:
        return "exempt"
    if d > t:
        return "upcoming"
    if d == t:
        return "today"
    if d < joined and minutes == 0:
        return "na"
    if d.weekday() > 4:
        return "rest"  # Sat/Sun are optional, so an unlogged one isn't a miss
    return "missed"


def streaks(qualified, exempt, t):
    """Consecutive days with the goal met. Saturday/Sunday are optional: an unlogged weekend
    day or an excused day neither counts nor breaks the streak; a missed weekday resets it."""
    def skippable(d):
        return d in exempt or d.weekday() > 4

    count, d = 0, t
    while d >= PROGRAM_START:
        if d in qualified:
            count += 1
        elif d != t and not skippable(d):  # today still pending: it doesn't break the streak yet
            break
        d -= timedelta(days=1)
    longest = run = 0
    prev = None
    for d in sorted(qualified):
        p = prev + timedelta(days=1) if prev else None
        while p and p < d and skippable(p):
            p += timedelta(days=1)
        run = run + 1 if p == d else 1
        longest = max(longest, run)
        prev = d
    return count, longest


def user_minutes(conn, uid):
    rows = conn.execute(
        "SELECT log_date, SUM(minutes) m FROM logs WHERE user_id=? GROUP BY log_date", (uid,))
    return {date.fromisoformat(r["log_date"]): r["m"] for r in rows}


def user_exemptions(conn, uid):
    rows = conn.execute("SELECT ex_date, reason FROM exemptions WHERE user_id=?", (uid,))
    return {date.fromisoformat(r["ex_date"]): r["reason"] for r in rows}


def week_days(monday, day_min, exempt, t, joined):
    out = []
    for i in range(7):
        d = monday + timedelta(days=i)
        m = day_min.get(d, 0)
        out.append({"date": d.isoformat(), "label": d.strftime("%a"), "minutes": m,
                    "status": day_status(d, m, exempt, t, joined),
                    "reason": exempt.get(d)})
    return out


def user_summary(conn, user):
    t = today()
    joined = PROGRAM_START  # accounts are created after the start; everyone counts from day one
    day_min = user_minutes(conn, user["id"])
    exempt = user_exemptions(conn, user["id"])
    qualified = {d for d, m in day_min.items() if m >= DAILY_MIN}
    current, longest = streaks(qualified, exempt, t)
    this_monday = monday_of(t)
    week = week_days(this_monday, day_min, exempt, t, joined)
    by_week = {}
    for d in qualified:
        by_week[monday_of(d)] = by_week.get(monday_of(d), 0) + 1
    return {
        "day_min": day_min, "exempt": exempt, "qualified": qualified, "joined": joined,
        "stats": {
            "current_streak": current, "longest_streak": longest, "active_days": len(qualified),
            "total_minutes": sum(day_min.values()),
            "perfect_weeks": sum(1 for n in by_week.values() if n >= WEEK_GOAL),
            "week_done": sum(1 for x in week if x["status"] == "done"),
        },
        "week": week, "this_monday": this_monday,
    }


def entry_dict(r):
    return {"id": r["id"], "date": r["log_date"], "activity": r["activity"],
            "minutes": r["minutes"], "note": r["note"], "at": r["created_at"]}


def request_dict(r):
    return dict(entry_dict(r), reason=r["reason"], status=r["status"])


# ---------------------------------------------------------------- handlers

def login_handler(conn, req, _):
    body = req.json()
    email, pw = str(body.get("email", "")).strip(), str(body.get("password", ""))
    key = (req.client_address[0], email.lower())
    req.check_throttle(key)
    u = conn.execute("SELECT * FROM users WHERE email=? AND active=1", (email,)).fetchone()
    # Hash even for unknown users so response time doesn't reveal which emails exist.
    ok = check_password(pw, u["password_hash"] if u else hash_password("x"))
    if not (u and ok):
        req.record_failure(key)
        raise ApiError(401, "Email or password is incorrect.")
    req.clear_failures(key)
    token = secrets.token_urlsafe(32)
    conn.execute("DELETE FROM sessions WHERE expires < ?", (int(now().timestamp()),))
    conn.execute("INSERT INTO sessions VALUES(?,?,?)", (
        hashlib.sha256(token.encode()).hexdigest(), u["id"],
        int(now().timestamp()) + SESSION_DAYS * 86400))
    conn.commit()
    req.set_cookie = token
    return {"ok": True}


def logout_handler(conn, req, _):
    tok = req.cookie_token()
    if tok:
        conn.execute("DELETE FROM sessions WHERE token_hash=?", (hashlib.sha256(tok.encode()).hexdigest(),))
        conn.commit()
    req.set_cookie = ""
    return {"ok": True}


def me_handler(conn, req, user):
    t = today()
    s = user_summary(conn, user)
    entries = [entry_dict(r) for r in conn.execute(
        "SELECT * FROM logs WHERE user_id=? AND log_date=? ORDER BY id", (user["id"], t.isoformat()))]
    weeks = []
    for k in range(1, HISTORY_WEEKS + 1):
        days = week_days(s["this_monday"] - timedelta(days=7 * k), s["day_min"], s["exempt"], t, s["joined"])
        weeks.append({"start": days[0]["date"], "days": days,
                      "done": sum(1 for d in days if d["status"] == "done")})
    recent = [entry_dict(r) for r in conn.execute(
        "SELECT * FROM logs WHERE user_id=? ORDER BY log_date DESC, id DESC LIMIT 10", (user["id"],))]
    requests = [request_dict(r) for r in conn.execute(
        "SELECT * FROM log_requests WHERE user_id=? AND (status='pending' OR decided_at>=?) ORDER BY id DESC",
        (user["id"], (t - timedelta(days=14)).isoformat()))]
    today_min = s["day_min"].get(t, 0)
    return {
        "user": {"email": user["email"],"name": user["name"], "is_admin": bool(user["is_admin"]),
                 "is_root": user["email"] == ROOT_EMAIL, "member_since": user["created_on"]},
        "today": {"date": t.isoformat(), "is_workday": t.weekday() < 5, "minutes": today_min,
                  "met": today_min >= DAILY_MIN, "entries": entries, "exempt": s["exempt"].get(t)},
        "stats": s["stats"], "week": s["week"], "weeks": weeks, "recent": recent, "requests": requests,
        "config": {"activities": ACTIVITIES + [OTHER_ACTIVITY], "other_activity": OTHER_ACTIVITY,
                   "other_max": OTHER_MAX, "daily_min": DAILY_MIN, "session_min": SESSION_MIN,
                   "session_max": SESSION_MAX, "week_goal": WEEK_GOAL,
                   "log_open_from": log_open_from(t).isoformat(), "log_back_days": LOG_BACK_DAYS,
                   "min_days": MIN_DAYS,
                   "program_start": PROGRAM_START.isoformat(),
"reason_max": REQUEST_REASON_MAX},
    }


def add_log_handler(conn, req, user):
    t = today()
    b = req.json()
    d = parse_day(b["date"]) if b.get("date") else t
    if d > t:
        raise ApiError(400, "You can't log a future date.")
    if d < PROGRAM_START:
        raise ApiError(400, "The programme started on %s; earlier dates can't be logged." % PROGRAM_START.strftime("%d %b"))
    activity = str(b.get("activity", ""))
    if activity == OTHER_ACTIVITY:
        other = " ".join(str(b.get("other", "")).split())
        if len(other) < 2:
            raise ApiError(400, "Name the activity you did.")
        activity = "%s: %s" % (OTHER_ACTIVITY, other[:OTHER_MAX])
    elif activity not in ACTIVITIES:
        raise ApiError(400, "Pick an activity from the list.")
    try:
        minutes = int(b.get("minutes"))
    except (TypeError, ValueError):
        raise ApiError(400, "Enter the duration in minutes.")
    if minutes < SESSION_MIN:
        raise ApiError(400, "Each session must be at least %d minutes." % SESSION_MIN)
    if minutes > SESSION_MAX:
        raise ApiError(400, "A single session can be at most %d minutes." % SESSION_MAX)
    note = str(b.get("note", "")).strip()[:200]
    check_day_capacity(conn, user["id"], d)

    if d < log_open_from(t):
        # Outside the open window: goes to an admin for approval instead of counting now.
        reason = " ".join(str(b.get("reason", "")).split())
        if len(reason) < 5:
            raise ApiError(400, "That date is past the logging window. Give a reason so the admin can approve it.")
        conn.execute("INSERT INTO log_requests(user_id,log_date,activity,minutes,note,reason,created_at) "
                     "VALUES(?,?,?,?,?,?,?)", (user["id"], d.isoformat(), activity, minutes, note,
                                               reason[:REQUEST_REASON_MAX], now().isoformat(timespec="seconds")))
        conn.commit()
        return {"ok": True, "requested": True}

    conn.execute("INSERT INTO logs(user_id,log_date,activity,minutes,note,created_at) VALUES(?,?,?,?,?,?)",
                 (user["id"], d.isoformat(), activity, minutes, note, now().isoformat(timespec="seconds")))

    celebration = None
    total = conn.execute("SELECT COUNT(*) FROM logs WHERE user_id=?", (user["id"],)).fetchone()[0]
    if total == 1:
        celebration = claim(conn, user["id"], "first", "1", {"kind": "first"})
    else:
        s = user_summary(conn, user)
        monday = monday_of(d)
        if d in s["qualified"] and sum(1 for q in s["qualified"] if monday_of(q) == monday) >= WEEK_GOAL:
            # One celebration per week (keyed by its Monday), even if entries are
            # deleted and re-added later the same day.
            celebration = claim(conn, user["id"], "week", monday.isoformat(),
                                {"kind": "week", "weeks": s["stats"]["perfect_weeks"]})
    conn.commit()
    return {"ok": True, "celebration": celebration}


def check_day_capacity(conn, uid, d):
    count = conn.execute("SELECT COUNT(*) FROM logs WHERE user_id=? AND log_date=?",
                         (uid, d.isoformat())).fetchone()[0]
    if count >= MAX_ENTRIES_PER_DAY:
        raise ApiError(400, "Too many entries for that day.")


def claim(conn, uid, kind, key, payload):
    cur = conn.execute("INSERT OR IGNORE INTO celebrations VALUES(?,?,?,?)",
                       (uid, kind, key, now().isoformat(timespec="seconds")))
    return payload if cur.rowcount else None


def delete_log_handler(conn, req, user, log_id):
    # Members may remove any of their own entries (today's or past, from Recent activity).
    cur = conn.execute("DELETE FROM logs WHERE id=? AND user_id=?", (int(log_id), user["id"]))
    conn.commit()
    if not cur.rowcount:
        raise ApiError(404, "Entry not found.")
    return {"ok": True}


def password_handler(conn, req, user):
    b = req.json()
    if not check_password(str(b.get("current", "")), user["password_hash"]):
        raise ApiError(400, "Current password is incorrect.")
    new = str(b.get("new", ""))
    if len(new) < 8:
        raise ApiError(400, "New password must be at least 8 characters.")
    conn.execute("UPDATE users SET password_hash=? WHERE id=?", (hash_password(new), user["id"]))
    conn.commit()
    return {"ok": True}


def require_admin(user):
    if not user["is_admin"]:
        raise ApiError(403, "Admin access required.")


def protect_root(conn, user, uid):
    """Coordinators can't reset, deactivate or re-role the main Admin account."""
    row = conn.execute("SELECT email FROM users WHERE id=?", (int(uid),)).fetchone()
    if row and row["email"] == ROOT_EMAIL and user["email"] != ROOT_EMAIL:
        raise ApiError(403, "Only the main Admin can change this account.")


def admin_members_handler(conn, req, user):
    require_admin(user)
    out = []
    for u in conn.execute("SELECT * FROM users ORDER BY is_admin DESC, name COLLATE NOCASE"):
        s = user_summary(conn, u)
        last = max(s["day_min"]) if s["day_min"] else None
        out.append({"id": u["id"], "email": u["email"], "name": u["name"], "active": bool(u["active"]),
                    "is_admin": bool(u["is_admin"]), "is_root": u["email"] == ROOT_EMAIL, "participates": bool(u["participates"]), "today_minutes": s["day_min"].get(today(), 0),
                    "week_done": s["stats"]["week_done"], "streak": s["stats"]["current_streak"],
                    "last_log": last.isoformat() if last else None})
    return {"members": out}


def admin_member_logs_handler(conn, req, user, uid):
    """One member's full log history (newest first) plus their pending late-entry requests."""
    require_admin(user)
    u = conn.execute("SELECT * FROM users WHERE id=?", (int(uid),)).fetchone()
    if not u:
        raise ApiError(404, "Member not found.")
    s = user_summary(conn, u)
    logs = [entry_dict(r) for r in conn.execute(
        "SELECT * FROM logs WHERE user_id=? ORDER BY log_date DESC, id DESC LIMIT 500", (u["id"],))]
    pending = [request_dict(r) for r in conn.execute(
        "SELECT * FROM log_requests WHERE user_id=? AND status='pending' ORDER BY log_date DESC, id DESC",
        (u["id"],))]
    return {"name": u["name"], "email": u["email"], "stats": s["stats"], "week": s["week"],
            "logs": logs, "pending": pending}


def admin_bulk_handler(conn, req, user):
    """Body text: one member per line, 'Full Name, email' (either order)."""
    require_admin(user)
    results = []
    for line in str(req.json().get("text", "")).splitlines():
        parts = [p.strip() for p in re.split(r"[,\t]", line) if p.strip()]
        if not parts:
            continue
        emails = [p for p in parts if "@" in p]
        if len(parts) < 2 or len(emails) != 1:
            results.append({"line": line.strip(), "status": "error", "detail": "Use: Full Name, email"})
            continue
        email = emails[0].lower()
        name = ", ".join(p for p in parts if p != emails[0])[:80]
        if len(email) > 120 or not EMAIL_RE.match(email):
            results.append({"line": line.strip(), "status": "error", "detail": "Invalid email"})
            continue
        if conn.execute("SELECT 1 FROM users WHERE email=?", (email,)).fetchone():
            results.append({"email": email, "name": name, "status": "error", "detail": "Already exists"})
            continue
        pw = new_password()
        conn.execute("INSERT INTO users(email,name,password_hash,created_on) VALUES(?,?,?,?)",
                     (email, name, hash_password(pw), today().isoformat()))
        results.append({"email": email, "name": name, "status": "created", "password": pw})
    conn.commit()
    return {"results": results}


def admin_reset_handler(conn, req, user, uid):
    require_admin(user)
    protect_root(conn, user, uid)
    pw = new_password()
    cur = conn.execute("UPDATE users SET password_hash=? WHERE id=?", (hash_password(pw), int(uid)))
    conn.execute("DELETE FROM sessions WHERE user_id=?", (int(uid),))
    conn.commit()
    if not cur.rowcount:
        raise ApiError(404, "Member not found.")
    return {"password": pw}


def admin_active_handler(conn, req, user, uid):
    require_admin(user)
    if int(uid) == user["id"]:
        raise ApiError(400, "You can't deactivate your own account.")
    protect_root(conn, user, uid)
    active = 1 if req.json().get("active") else 0
    conn.execute("UPDATE users SET active=? WHERE id=?", (active, int(uid)))
    if not active:
        conn.execute("DELETE FROM sessions WHERE user_id=?", (int(uid),))
    conn.commit()
    return {"ok": True}


def admin_role_handler(conn, req, user, uid):
    require_admin(user)
    if int(uid) == user["id"]:
        raise ApiError(400, "You can't change your own role.")
    protect_root(conn, user, uid)
    conn.execute("UPDATE users SET is_admin=? WHERE id=?", (1 if req.json().get("is_admin") else 0, int(uid)))
    conn.commit()
    return {"ok": True}


def parse_day(value):
    try:
        return date.fromisoformat(str(value))
    except ValueError:
        raise ApiError(400, "Invalid date.")


def participants(conn):
    return conn.execute("SELECT * FROM users WHERE active=1 AND participates=1 ORDER BY name COLLATE NOCASE").fetchall()


def leaderboard_handler(conn, req, user):
    """Aggregates only - individual log entries are never exposed to other members."""
    period = "month" if req.qv("period") == "month" else "week"
    t = today()
    start = t.replace(day=1) if period == "month" else monday_of(t)
    rows = []
    for u in participants(conn):
        s = user_summary(conn, u)
        rows.append({
            "name": u["name"], "me": u["id"] == user["id"],
            "days": sum(1 for d in s["qualified"] if start <= d <= t),
            "minutes": sum(m for d, m in s["day_min"].items() if start <= d <= t),
            "streak": s["stats"]["current_streak"], "perfect_weeks": s["stats"]["perfect_weeks"],
            "week": [x["status"] for x in s["week"]],
        })
    rows.sort(key=lambda r: (-r["streak"], -r["minutes"], r["name"].lower()))
    rank, prev = 0, None
    for r in rows:
        if (r["streak"], r["minutes"]) != prev:
            rank, prev = rank + 1, (r["streak"], r["minutes"])  # dense: ties share a rank, next rank is +1
        r["rank"] = rank
    return {"period": period, "since": start.isoformat(), "rows": rows}


def admin_exemptions_handler(conn, req, user):
    require_admin(user)
    since = (today() - timedelta(days=45)).isoformat()
    rows = conn.execute(
        "SELECT e.user_id, e.ex_date, e.reason, u.name, u.email FROM exemptions e JOIN users u ON u.id=e.user_id "
        "WHERE e.ex_date>=? ORDER BY e.ex_date DESC, u.name COLLATE NOCASE", (since,))
    return {"reasons": EXEMPT_REASONS, "other_max": EXEMPT_OTHER_MAX,
            "items": [{"user_id": r["user_id"], "date": r["ex_date"], "reason": r["reason"],
                       "name": r["name"], "email": r["email"]} for r in rows]}


def admin_exemption_add_handler(conn, req, user):
    require_admin(user)
    b = req.json()
    reason = str(b.get("reason", ""))
    if reason not in EXEMPT_REASONS:
        raise ApiError(400, "Pick a reason from the list.")
    if reason == "Other":
        detail = " ".join(str(b.get("other", "")).split())
        if len(detail) < 2:
            raise ApiError(400, "Mention the reason for the leave.")
        reason = "Other: %s" % detail[:EXEMPT_OTHER_MAX]
    try:
        uid = int(b.get("user_id"))
    except (TypeError, ValueError):
        raise ApiError(400, "Pick a member.")
    if not conn.execute("SELECT 1 FROM users WHERE id=?", (uid,)).fetchone():
        raise ApiError(404, "Member not found.")
    start, end = parse_day(b.get("from")), parse_day(b.get("to") or b.get("from"))
    if end < start or (end - start).days > 62:
        raise ApiError(400, "Date range must run forwards and be at most 2 months.")
    added, d = 0, start
    while d <= end:
        conn.execute("INSERT OR REPLACE INTO exemptions VALUES(?,?,?)", (uid, d.isoformat(), reason))
        added += 1
        d += timedelta(days=1)
    conn.commit()
    return {"added": added}


def admin_exemption_delete_handler(conn, req, user, uid, day):
    require_admin(user)
    conn.execute("DELETE FROM exemptions WHERE user_id=? AND ex_date=?", (int(uid), day))
    conn.commit()
    return {"ok": True}


def admin_requests_handler(conn, req, user):
    """Late-entry requests: all pending, plus those decided in the last 30 days."""
    require_admin(user)
    since = (today() - timedelta(days=30)).isoformat()
    rows = conn.execute(
        "SELECT r.*, u.name, u.email FROM log_requests r JOIN users u ON u.id=r.user_id "
        "WHERE r.status='pending' OR r.decided_at>=? ORDER BY r.status='pending' DESC, r.id DESC", (since,))
    return {"items": [dict(request_dict(r), name=r["name"], email=r["email"]) for r in rows]}


def admin_request_decide_handler(conn, req, user, rid):
    require_admin(user)
    r = conn.execute("SELECT * FROM log_requests WHERE id=? AND status='pending'", (int(rid),)).fetchone()
    if not r:
        raise ApiError(404, "Request not found or already decided.")
    approve = bool(req.json().get("approve"))
    if approve:
        check_day_capacity(conn, r["user_id"], date.fromisoformat(r["log_date"]))
        conn.execute("INSERT INTO logs(user_id,log_date,activity,minutes,note,created_at) VALUES(?,?,?,?,?,?)",
                     (r["user_id"], r["log_date"], r["activity"], r["minutes"], r["note"], r["created_at"]))
    conn.execute("UPDATE log_requests SET status=?, decided_by=?, decided_at=? WHERE id=?",
                 ("approved" if approve else "rejected", user["id"], now().isoformat(timespec="seconds"), r["id"]))
    conn.commit()
    return {"ok": True}


def admin_report_handler(conn, req, user):
    """Weekly compliance + fine report for one Mon-Sun week (T&C: fine when done days fall short of
    MIN_DAYS minus the number of excused days). Fines are only issued once the week is final: after Sunday has left
    the direct-logging window (Sunday + LOG_BACK_DAYS), so members can still log it until then."""
    require_admin(user)
    t = today()
    week_arg = req.qv("week")
    monday = min(monday_of(parse_day(week_arg)) if week_arg else monday_of(t), monday_of(t))
    final_on = monday + timedelta(days=7 + LOG_BACK_DAYS)  # first day Sunday can no longer be logged directly
    final = t >= final_on
    rows = []
    for u in participants(conn):
        s = user_summary(conn, u)
        days = week_days(monday, s["day_min"], s["exempt"], t, s["joined"])
        count = lambda status: sum(1 for x in days if x["status"] == status)
        done, excused = count("done"), count("exempt")
        # Each excused day lowers the days needed by one (3 excused or more = nothing needed).
        short = max(0, MIN_DAYS - excused - done)
        # The week holding PROGRAM_START is a partial week, so it is never fined.
        fined = final and monday >= PROGRAM_START and short > 0
        rows.append({"name": u["name"], "email": u["email"], "done": done,
                     "excused": excused, "short": short,
                     "fine": FINE_PER_WEEK if fined else 0,
                     "days": [x["status"] for x in days]})
    rows.sort(key=lambda r: (-r["fine"], -r["short"], r["name"].lower()))
    return {"week": monday.isoformat(), "is_current": monday == monday_of(t),
            "provisional": not final, "final_on": final_on.isoformat(),
            "can_next": monday < monday_of(t), "rows": rows,
            "total_fine": sum(r["fine"] for r in rows), "fine_per_week": FINE_PER_WEEK, "min_days": MIN_DAYS}


# method, path regex, handler, needs_auth
ROUTES = [
    ("GET", r"/api/leaderboard", leaderboard_handler, True),
    ("GET", r"/api/admin/exemptions", admin_exemptions_handler, True),
    ("POST", r"/api/admin/exemptions", admin_exemption_add_handler, True),
    ("DELETE", r"/api/admin/exemptions/(\d+)/(\d{4}-\d{2}-\d{2})", admin_exemption_delete_handler, True),
    ("GET", r"/api/admin/report", admin_report_handler, True),
    ("GET", r"/api/admin/log-requests", admin_requests_handler, True),
    ("POST", r"/api/admin/log-requests/(\d+)", admin_request_decide_handler, True),
    ("POST", r"/api/admin/members/(\d+)/role", admin_role_handler, True),
    ("POST", r"/api/login", login_handler, False),
    ("POST", r"/api/logout", logout_handler, False),
    ("GET", r"/api/me", me_handler, True),
    ("POST", r"/api/logs", add_log_handler, True),
    ("DELETE", r"/api/logs/(\d+)", delete_log_handler, True),
    ("POST", r"/api/password", password_handler, True),
    ("GET", r"/api/admin/members", admin_members_handler, True),
    ("GET", r"/api/admin/members/(\d+)/logs", admin_member_logs_handler, True),
    ("POST", r"/api/admin/members/bulk", admin_bulk_handler, True),
    ("POST", r"/api/admin/members/(\d+)/reset", admin_reset_handler, True),
    ("POST", r"/api/admin/members/(\d+)/active", admin_active_handler, True),
]

MIME = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
        ".ico": "image/x-icon", ".woff2": "font/woff2"}
CSP = ("default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; "
       "frame-ancestors 'none'; base-uri 'none'; form-action 'self'")

FAILURES = {}  # (ip, email) -> [timestamps]; in-memory login throttle
MAX_FAILS, FAIL_WINDOW = 5, 600


class Handler(BaseHTTPRequestHandler):
    server_version = "GDDFit"
    set_cookie = None

    def do_GET(self): self.dispatch("GET")
    def do_POST(self): self.dispatch("POST")
    def do_DELETE(self): self.dispatch("DELETE")

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (now().strftime("%H:%M:%S"), fmt % args))

    # -- request helpers
    def json(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n > 65536:
                raise ValueError
            data = json.loads(self.rfile.read(n) or b"{}")
            if not isinstance(data, dict):
                raise ValueError
            return data
        except ValueError:
            raise ApiError(400, "Invalid request.")

    def cookie_token(self):
        c = cookies.SimpleCookie(self.headers.get("Cookie", ""))
        return c["gdd_session"].value if "gdd_session" in c else None

    def current_user(self, conn):
        tok = self.cookie_token()
        if not tok:
            return None
        return conn.execute(
            "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id "
            "WHERE s.token_hash=? AND s.expires>? AND u.active=1",
            (hashlib.sha256(tok.encode()).hexdigest(), int(now().timestamp()))).fetchone()

    def check_throttle(self, key):
        cutoff = now().timestamp() - FAIL_WINDOW
        FAILURES[key] = [x for x in FAILURES.get(key, []) if x > cutoff]
        if len(FAILURES[key]) >= MAX_FAILS:
            raise ApiError(429, "Too many failed attempts. Try again in 10 minutes or ask the admin.")

    def record_failure(self, key):
        FAILURES.setdefault(key, []).append(now().timestamp())

    def clear_failures(self, key):
        FAILURES.pop(key, None)

    # -- routing
    def qv(self, name):
        return (self.query.get(name) or [""])[0]

    def dispatch(self, method):
        self.set_cookie = None
        self.query = parse_qs(urlparse(self.path).query)
        path = urlparse(self.path).path
        if path.startswith("/api/"):
            return self.api(method, path)
        if method != "GET":
            return self.send_json({"error": "Method not allowed"}, 405)
        self.static(path)

    def api(self, method, path):
        try:
            origin = self.headers.get("Origin")
            if method != "GET" and origin and urlparse(origin).netloc != self.headers.get("Host"):
                raise ApiError(403, "Cross-site request blocked.")
            for m, pattern, fn, needs_auth in ROUTES:
                match = re.fullmatch(pattern, path)
                if m == method and match:
                    break
            else:
                raise ApiError(404, "Not found")
            conn = db()
            try:
                user = self.current_user(conn)
                if needs_auth and not user:
                    raise ApiError(401, "Please sign in.")
                result = fn(conn, self, user, *match.groups()) if needs_auth else fn(conn, self, user)
            finally:
                conn.close()
            self.send_json(result)
        except ApiError as e:
            self.send_json({"error": e.msg}, e.status)
        except Exception:
            traceback.print_exc()
            self.send_json({"error": "Something went wrong on the server."}, 500)

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.security_headers()
        if self.set_cookie is not None:
            attrs = "gdd_session=%s; Path=/; HttpOnly; SameSite=Strict" % self.set_cookie
            attrs += "; Max-Age=%d" % (SESSION_DAYS * 86400 if self.set_cookie else 0)
            if SECURE_COOKIE:
                attrs += "; Secure"
            self.send_header("Set-Cookie", attrs)
        self.end_headers()
        self.wfile.write(body)

    def security_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("Referrer-Policy", "same-origin")

    def static(self, path):
        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        f = (STATIC / rel).resolve()
        if STATIC not in f.parents or not f.is_file():
            return self.send_json({"error": "Not found"}, 404)
        body = f.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(f.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.security_headers()
        self.end_headers()
        self.wfile.write(body)


def cli_set_password(email):
    init_db()
    conn = db()
    pw = new_password()
    cur = conn.execute("UPDATE users SET password_hash=? WHERE email=?", (hash_password(pw), email))
    conn.commit()
    print("New password for %s: %s" % (email, pw) if cur.rowcount else "No such account.")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "set-password":
        cli_set_password(sys.argv[2])
        sys.exit()
    init_db()
    print("November Fitness Challenge running on http://localhost:%d  (share http://<this-pc-ip>:%d with the team)" % (PORT, PORT))
    try:
        ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
