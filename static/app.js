"use strict";

const app = document.getElementById("app");
const state = {
  me: null, view: "home", members: null, issued: null,
  board: null, boardPeriod: "week", leave: null, report: null, reportWeek: "", requests: null,
};

// ---------------------------------------------------------------- utilities

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
const fmtDate = (iso, opts) => new Date(iso + "T00:00:00").toLocaleDateString("en-IN", opts || { weekday: "short", day: "numeric", month: "short" });
const fmtTime = (iso) => new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
const fmtMins = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60 ? (m % 60) + "m" : ""}`.trim() : `${m} min`);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
// Theme: a saved choice sets data-theme on <html> (overrides the OS); otherwise follow prefers-color-scheme.
const darkQuery = matchMedia("(prefers-color-scheme: dark)");
const isDark = () => (document.documentElement.dataset.theme || (darkQuery.matches ? "dark" : "light")) === "dark";
try { const t = localStorage.getItem("theme"); if (t === "light" || t === "dark") document.documentElement.dataset.theme = t; } catch {}
const themeLabel = () => (isDark() ? "☀" : "☾");
const themeBtn = () => `<button type="button" class="theme-toggle" data-action="theme" aria-label="Switch to ${isDark() ? "light" : "dark"} theme">${themeLabel()}</button>`;
const syncThemeBtns = () => document.querySelectorAll(".theme-toggle").forEach((b) => {
  b.textContent = themeLabel();
  b.setAttribute("aria-label", `Switch to ${isDark() ? "light" : "dark"} theme`);
});
darkQuery.addEventListener("change", syncThemeBtns);
const isoShift = (iso, days) => {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + days);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
};

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "/api/login") {
    state.me = null;
    render();
  }
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.setAttribute("role", "status");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// ---------------------------------------------------------------- modal + confetti

let lastFocus = null;
function showModal(html, { pop = false, formClass = "" } = {}) {
  closeModal();
  lastFocus = document.activeElement;
  const ov = document.createElement("div");
  ov.className = "overlay";
  ov.id = "overlay";
  ov.innerHTML = `<div class="modal ${pop ? "pop" : ""} ${formClass}" role="dialog" aria-modal="true">${html}</div>`;
  ov.addEventListener("click", (e) => { if (e.target === ov) closeModal(); });
  document.body.appendChild(ov);
  const first = ov.querySelector("input, button");
  if (first) first.focus();
}
function closeModal() {
  const ov = document.getElementById("overlay");
  if (ov) ov.remove();
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

function confetti() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const cv = document.getElementById("confetti");
  const ctx = cv.getContext("2d");
  cv.width = innerWidth;
  cv.height = innerHeight;
  const colors = ["#0093d2", "#33c2ff", "#006a92", "#12314c", "#f0b429", "#def4fd"];
  const parts = Array.from({ length: 160 }, () => ({
    x: Math.random() * cv.width, y: -20 - Math.random() * cv.height * 0.5,
    w: 6 + Math.random() * 6, h: 10 + Math.random() * 8, vx: -2 + Math.random() * 4,
    vy: 2 + Math.random() * 4, rot: Math.random() * 6, vr: -0.2 + Math.random() * 0.4,
    c: colors[Math.floor(Math.random() * colors.length)],
  }));
  const end = performance.now() + 3500;
  (function frame(t) {
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy; p.vy += 0.03; p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (t < end) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, cv.width, cv.height);
  })(performance.now());
}

function celebrate(c) {
  const first = esc(state.me.user.name.split(/\s+/)[0]);
  let emoji, title, msg;
  if (c.kind === "first") {
    emoji = "🎉";
    title = "You've logged your first activity!";
    msg = `Welcome to the November Fitness Challenge, ${first}. Every habit starts with day one — see you tomorrow!`;
  } else {
    emoji = "🏆";
    title = "Well done — perfect week!";
    msg = `${state.me.config.week_goal} days this week with your 30 minutes done, ${first}. That's ${plural(c.weeks, "perfect week")} so far. Keep it up!`;
  }
  showModal(`<div class="big" aria-hidden="true">${emoji}</div><h2>${title}</h2><p>${msg}</p>
    <button class="btn" data-action="close-modal">Keep going</button>`, { pop: true });
  confetti();
}

// ---------------------------------------------------------------- shared view pieces

const STATUS_ICON = { done: "✓", missed: "✕", today: "•", upcoming: "", na: "", exempt: "–", rest: "" };
const STATUS_LABEL = { done: "goal met", missed: "missed", today: "today", upcoming: "upcoming", na: "before joining", exempt: "excused", rest: "rest day" };
// Password input with a Show/Hide toggle; attrs is the input's attribute string (must include id).
const pwField = (attrs) => `<div class="pw-wrap"><input type="password" ${attrs}>` +
  `<button type="button" class="pw-toggle" data-action="toggle-pw" aria-pressed="false" aria-label="Show password">Show</button></div>`;
const pips = (days) => `<span class="pips">${days.map((s) => `<span class="pip ${s}" title="${STATUS_LABEL[s]}"></span>`).join("")}</span>`;

// head: { eyebrow, title, sub } for the page banner; values must already be escaped.
function shell(inner, head) {
  const u = state.me.user;
  const tabs = [["home", "My profile"], ["board", "Leaderboard"], ["terms", "Terms &amp; Conditions"]];
  if (u.is_admin) tabs.push(["members", "Members"], ["leave", "Leave"], ["requests", "Requests"], ["report", "Fine report"]);
  const nav = `<nav class="nav" aria-label="Main">${tabs.map(([v, label]) =>
    `<button data-action="nav" data-view="${v}" ${state.view === v ? 'aria-current="page"' : ""}>${label}</button>`).join("")}</nav>`;
  return `<header class="topbar"><div class="topbar-in">
      <div class="brand"><img class="brand-mark" src="/RV.svg" alt="Aarvee"><span class="brand-sep" aria-hidden="true"></span><span class="brand-title">November Fitness Challenge</span></div>
      ${nav}
      ${themeBtn()}
    </div></header>
    <div class="page-head lines"><div class="page-head-in">
      <p class="eyebrow">${head.eyebrow}</p><h1>${head.title}</h1>${head.sub ? `<p class="sub">${head.sub}</p>` : ""}
    </div></div>
    ${inner}
    <footer class="footer"><div class="footer-in">
      <div class="footer-brand"><img src="/RV.svg" alt="Aarvee"></div>
      <span>30 minutes a day, at least 5 days a week · © ${new Date().getFullYear()} Aarvee Engineering Consultants Limited</span>
    </div></footer>`;
}

// ---------------------------------------------------------------- login

function loginView() {
  return `<div class="login-wrap">
    <section class="login-hero lines" aria-label="About November Fitness Challenge">
      <div class="login-hero-copy">
        <img class="login-logo" src="/aarvee.svg" alt="Aarvee">
        <p class="eyebrow">November Fitness Challenge</p>
        <h1>30 Minutes a Day for a Healthier Aarvee</h1>
        <p class="lead">Log your daily activity, build your streak and chase a perfect week with your team.</p>
      </div>
      <ul class="login-facts">
        <li><b>30 min</b>on each exercise day</li>
        <li><b>5 days</b>a week, Mon–Sun</li>
        <li><b>15 min</b>minimum per entry</li>
      </ul>
    </section>
    <div class="login-side">${themeBtn()}<form class="login-card" data-form="login" autocomplete="on">
    <h2>Sign in</h2>
    <p class="tagline">Welcome to the November Fitness Challenge. Use your email address to continue.</p>
    <label for="email">Email</label>
    <input id="email" name="email" inputmode="email" autocomplete="username" autocapitalize="off" spellcheck="false" required autofocus>
    <label for="pw">Password</label>
    ${pwField('id="pw" name="password" autocomplete="current-password" required')}
    <p class="error" role="alert"></p>
    <button class="btn block" type="submit">Sign in</button>
    <p class="hint">No account or forgot your password? Ask the admin.</p>
  </form></div></div>`;
}

// ---------------------------------------------------------------- home (profile + log)

function profileCard() {
  const { user, stats } = state.me;
  return `<section class="card profile" aria-label="Profile">
    <div class="avatar" aria-hidden="true">${esc(initials(user.name))}</div>
    <h2>${esc(user.name)}</h2>
    <div class="muted email">${esc(user.email)}</div>
    ${user.is_root ? '<span class="badge">Admin</span>' : user.is_admin ? '<span class="badge">Coordinator</span>' : ""}
    <div class="hint">Member since ${fmtDate(user.member_since, { day: "numeric", month: "short", year: "numeric" })}</div>
    <div class="stats">
      <div class="stat streak"><b>${stats.current_streak}</b><span>Current streak (days)</span></div>
      <div class="stat"><b>${stats.longest_streak}</b><span>Longest streak</span></div>
      <div class="stat"><b>${stats.perfect_weeks}</b><span>Perfect weeks</span></div>
      <div class="stat"><b>${stats.active_days}</b><span>Goal days met</span></div>
      <div class="stat wide"><b>${fmtMins(stats.total_minutes)}</b><span>Total active time</span></div>
    </div>
    <div class="profile-actions">
      <button class="btn ghost" data-action="change-pw">Change password</button>
      <button class="btn ghost" data-action="logout">Sign out</button>
    </div>
  </section>`;
}

function ringSvg(minutes, goal) {
  const r = 52, c = 2 * Math.PI * r, off = c * (1 - Math.min(1, minutes / goal));
  return `<div class="ring"><svg width="120" height="120" viewBox="0 0 120 120" aria-hidden="true">
      <circle class="track" cx="60" cy="60" r="${r}" fill="none" stroke-width="10"/>
      <circle class="bar" cx="60" cy="60" r="${r}" fill="none" stroke-width="10" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/>
    </svg><div class="label"><b>${minutes}</b><span>of ${goal} min</span></div></div>`;
}

function todayCard() {
  const { today, config, stats } = state.me;
  let head;
  if (today.met) {
    head = `<h3>Today's goal complete ✓</h3><p>${fmtMins(today.minutes)} logged. Anything extra is a bonus — add it below.</p>`;
  } else if (today.exempt) {
    head = `<h3>You're excused today</h3><p>${esc(today.exempt)}. You can still log if you exercise.</p>`;
  } else if (today.minutes > 0) {
    head = `<h3>Almost there</h3><p>Log one more session of ${config.session_min}+ minutes to complete today.</p>`;
  } else {
    const risk = stats.current_streak > 0 ? ` Your ${stats.current_streak}-day streak is waiting.` : "";
    head = `<h3>${config.daily_min} minutes to go</h3><p>One ${config.daily_min}-minute session, or two of ${config.session_min}+ minutes each.${risk}</p>`;
  }
  const entries = today.entries.length
    ? `<ul class="entries">${today.entries.map((e) => `<li>
        <div class="grow"><strong>${esc(e.activity)}</strong> <span class="muted">· ${fmtTime(e.at)}</span>
        ${e.note ? `<div class="note">${esc(e.note)}</div>` : ""}</div>
        <span class="mins">${e.minutes} min</span>
        <button class="btn danger small" data-action="delete-log" data-id="${e.id}" aria-label="Delete ${esc(e.activity)} entry">Delete</button></li>`).join("")}</ul>`
    : "";
  const logDate = today.date;
  const form = `<hr class="divider">
    <form data-form="log">
      <div class="form-grid">
        <div class="full"><label for="log-date">Date</label>
          <input id="log-date" name="date" type="date" value="${logDate}" min="${config.program_start}" max="${today.date}" required></div>
        <div class="full" id="reason-wrap" hidden><label for="reason">Reason for late entry</label>
          <input id="reason" name="reason" maxlength="${config.reason_max}" minlength="5" placeholder="e.g. Was travelling and couldn't log" disabled required>
          <p class="hint">This date is past the logging window, so an admin must approve it before it counts.</p></div>
        <div class="full"><label for="activity">Activity</label>
          <select id="activity" name="activity" required>${config.activities.map((a) => `<option>${esc(a)}</option>`).join("")}</select></div>
        <div class="full" id="other-wrap" hidden><label for="other">Which activity?</label>
          <input id="other" name="other" maxlength="${config.other_max}" placeholder="e.g. Trekking, Pilates, Table tennis" disabled required></div>
        <div class="full"><label for="minutes">Duration (minutes)</label>
          <div class="chips" role="group" aria-label="Quick duration">
            ${[15, 30, 45, 60].map((m) => `<button type="button" class="chip" data-action="chip" data-m="${m}" aria-pressed="${m === 30}">${m}</button>`).join("")}
          </div></div>
        <div><input id="minutes" name="minutes" type="number" inputmode="numeric" min="${config.session_min}" max="${config.session_max}" value="30" required aria-label="Duration in minutes"></div>
        <div><input id="note" name="note" maxlength="200" placeholder="Note (optional)" aria-label="Note (optional)"></div>
      </div>
      <p class="hint">Minimum ${config.session_min} min per entry. Any day, Monday to Sunday, counts. You can log today and the previous ${config.log_back_days} days. Older days need admin approval. Commute and office walking don't count.</p>
      <p class="error" role="alert"></p>
      <button class="btn" type="submit" id="log-submit">Log activity</button>
    </form>`;
  return `<section class="card" aria-label="Today">
    <h2>Today · ${fmtDate(today.date, { weekday: "long", day: "numeric", month: "long" })}</h2>
    <div class="today-top">${ringSvg(today.minutes, config.daily_min)}<div class="today-msg">${head}</div></div>
    ${entries}${form}</section>`;
}

function weekCard() {
  const { week, stats, config } = state.me;
  return `<section class="card" aria-label="This week"><div class="row spread"><h2>This week</h2><span class="muted">${stats.week_done} / ${config.week_goal} days${stats.week_done >= config.week_goal ? " 🏆" : ""}</span></div>
    <div class="week">${week.map((d) => `<div class="day ${d.status}">
      <small>${d.label}</small><div class="dot" role="img" aria-label="${d.label}: ${STATUS_LABEL[d.status]}, ${d.minutes} minutes">${STATUS_ICON[d.status]}</div>
      <small>${d.minutes ? d.minutes + " min" : d.status === "exempt" ? "Excused" : "–"}</small></div>`).join("")}</div></section>`;
}

const REQ_TAG = { pending: '<span class="tag">Pending</span>', approved: '<span class="tag ok">Approved</span>', rejected: '<span class="tag">Rejected</span>' };

const fmtRange = (from, to) => from === to ? fmtDate(from) : `${fmtDate(from)} – ${fmtDate(to)}`;

function leaveCard() {
  const { user, config, today, leave_requests: reqs } = state.me;
  if (!user.participates) return "";
  const list = reqs.length ? `<ul class="entries">${reqs.map((r) => `<li>
      <div class="grow"><strong>${esc(fmtRange(r.from, r.to))}</strong> <span class="muted">· ${plural(r.days, "day")}</span><div class="note">${esc(r.reason)}</div></div>
      ${REQ_TAG[r.status]}
      ${r.status === "pending" ? `<button class="btn danger small" data-action="cancel-leave" data-id="${r.id}" aria-label="Cancel leave request for ${esc(fmtRange(r.from, r.to))}">Cancel</button>` : ""}</li>`).join("")}</ul><hr class="divider">` : "";
  return `<section class="card" aria-label="Apply for leave"><h2>Apply for leave</h2>
    <p class="hint">Away for a valid reason? Apply here and a coordinator will approve it. Each excused day lowers the ${config.min_days} days you need that week by one and doesn't break your streak. Let the coordinator know in advance or within 24 hours.</p>
    ${list}
    <form data-form="leave-request"><div class="form-grid">
      <div><label for="lr-from">From</label><input id="lr-from" name="from" type="date" value="${today.date}" min="${config.program_start}" required></div>
      <div><label for="lr-to">To</label><input id="lr-to" name="to" type="date" value="${today.date}" min="${config.program_start}" required></div>
      <div class="full"><label for="lr-reason">Reason</label><select id="lr-reason" name="reason" required>
        ${config.leave_reasons.map((r) => `<option>${esc(r)}</option>`).join("")}</select></div>
      <div class="full" id="lr-other-wrap" hidden><label for="lr-other">Please mention the reason</label>
        <input id="lr-other" name="other" maxlength="${config.leave_other_max}" placeholder="e.g. Wedding in the family, Court hearing" disabled required></div></div>
      <p class="error" role="alert"></p>
      <button class="btn" type="submit">Send for approval</button></form></section>`;
}

function historyCard() {
  const { weeks, recent, requests } = state.me;
  return `<section class="card" aria-label="History"><h2>Previous weeks</h2><div class="weeks">
    ${weeks.map((w) => `<div class="wk"><span class="muted">Wk of ${fmtDate(w.start, { day: "numeric", month: "short" })}</span>
      ${pips(w.days.map((d) => d.status))}<strong>${w.done}/5</strong></div>`).join("")}</div>
    ${requests.length ? `<hr class="divider"><h2>Late-entry requests</h2><ul class="entries">${requests.map((r) => `<li>
      <div class="grow"><strong>${esc(r.activity)}</strong><div class="note">${esc(r.reason)}</div></div>
      <span class="muted">${fmtDate(r.date)}</span><span class="mins">${r.minutes} min</span>${REQ_TAG[r.status]}</li>`).join("")}</ul>` : ""}
    ${recent.length ? `<hr class="divider"><h2>Recent activity</h2><ul class="entries">${recent.map((e) => `<li>
      <div class="grow"><strong>${esc(e.activity)}</strong>${e.note ? `<div class="note">${esc(e.note)}</div>` : ""}</div>
      <span class="muted">${fmtDate(e.date)}</span><span class="mins">${e.minutes} min</span>
      <button class="btn danger small" data-action="delete-log" data-id="${e.id}" aria-label="Delete ${esc(e.activity)} entry from ${esc(fmtDate(e.date))}">Delete</button></li>`).join("")}</ul>` : ""}
  </section>`;
}

function homeView() {
  const h = new Date().getHours();
  const greet = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  const { config } = state.me;
  return shell(`<main class="page">${profileCard()}<div class="stack">${todayCard()}${weekCard()}${leaveCard()}${historyCard()}</div></main>`, {
    eyebrow: "My profile",
    title: `${greet}, ${esc(state.me.user.name.split(/\s+/)[0])}`,
    sub: `${config.daily_min} minutes a day, at least ${config.week_goal} days a week (Monday to Sunday). Log today's activity and keep your streak going.`,
  });
}

// ---------------------------------------------------------------- leaderboard

function boardView() {
  const b = state.board;
  const week = b.period === "week";
  const medal = (r) => ((r.streak > 0 || r.minutes > 0) && r.rank <= 3 ? ["🥇", "🥈", "🥉"][r.rank - 1] : `<span class="rank-num">${r.rank}</span>`);
  const rows = b.rows.map((r) => `<tr class="${r.me ? "me" : ""}">
      <td class="rank">${medal(r)}</td>
      <td><button class="link-btn" data-action="view-week" data-id="${r.id}" title="See this week's activities">${esc(r.name)}</button>${r.me ? ' <span class="tag ok">You</span>' : ""}</td>
      <td>${week ? pips(r.week) + ` <strong>${r.days}/5</strong>` : `<strong>${r.days}</strong> days`}</td>
      <td>${fmtMins(r.minutes)}</td><td>🔥 ${r.streak}</td><td>🏆 ${r.perfect_weeks}</td><td><strong>${r.score}</strong></td></tr>`).join("");
  return shell(`<main class="page single"><section class="card" aria-label="Leaderboard">
    <div class="row spread"><h2>Rankings</h2>
      <div class="chips" role="group" aria-label="Period">
        <button class="chip" data-action="period" data-p="week" aria-pressed="${week}">This week</button>
        <button class="chip" data-action="period" data-p="month" aria-pressed="${!week}">This month</button></div></div>
    <p class="hint">Score = current streak days × 2 h (120 min) + time logged since ${fmtDate(b.since, { day: "numeric", month: "short" })}, in minutes. Streak counts most, but extra time can close a streak gap. The month view helps pick the Fitness Champion of the Month.</p>
    <div class="table-wrap"><table><thead><tr><th>#</th><th>Member</th><th>${week ? "This week" : "Goal days"}</th><th>Time</th><th>Streak</th><th>Perfect weeks</th><th>Score</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="7" class="muted">No members yet.</td></tr>'}</tbody></table></div></section></main>`, {
    eyebrow: "Leaderboard",
    title: week ? "This week's standings" : "This month's standings",
    sub: "Click a member's name to see the activities they logged this week.",
  });
}

function weekActivityModal(m) {
  const byDate = new Map();
  for (const e of m.logs) byDate.set(e.date, [...(byDate.get(e.date) || []), e]);
  const days = [...byDate].map(([date, es]) => `<h3>${esc(fmtDate(date))} · ${fmtMins(es.reduce((n, e) => n + e.minutes, 0))}</h3>
    <ul class="entries">${es.map((e) => `<li><div class="grow"><strong>${esc(e.activity)}</strong></div><span>${e.minutes} min</span></li>`).join("")}</ul>`).join("");
  showModal(`<h2>${esc(m.name)}${m.me ? ' <span class="tag ok">You</span>' : ""}</h2>
    <p class="muted">Week of ${esc(fmtDate(m.week_start, { day: "numeric", month: "short" }))}</p>
    <div>${pips(m.week.map((x) => x.status))} <strong>${m.days_done}/5</strong> this week · ${fmtMins(m.logs.reduce((n, e) => n + e.minutes, 0))} logged</div>
    ${days || '<p class="hint">No activity logged yet this week.</p>'}
    <div class="row mt16"><button class="btn" data-action="close-modal">Close</button></div>`, { formClass: "wide" });
}

// ---------------------------------------------------------------- terms & conditions

// Source: "GDD fitness.docx" (declaration section intentionally left out).
const TERMS = [
  ["Weekly commitment", "Each participant must complete a minimum of 30 minutes of physical exercise on at least 5 days per week. The week runs Monday to Sunday and any day, including Saturday and Sunday, may be used. Each day's 30 minutes may be done in one session or in a maximum of two sessions of at least 15 minutes each."],
  ["Eligible activities", "Dedicated brisk walking, jogging or running, cycling, gym or strength training, yoga, swimming, outdoor or indoor sports, aerobics, dance workouts, skipping, and home workouts."],
  ["Activities that do NOT count", "Office Commute (to and fro), movement within the office during work hours, routine stair use, household chores, and walking during site visits as part of official duties."],
  ["Logging and proof", "Participants must record their daily activity in the designated tracker or group. Any day from Monday to Sunday can be logged, up to 4 days after the activity. Older entries need the coordinator's approval and a reason."],
  ["Penalty for non-compliance", "A participant who completes the daily exercise on fewer than 3 days in a calendar week (Monday to Sunday) shall pay a fine of ₹50 for that week. Each day excused for a valid reason reduces the required days by one (1 excused day: 2 days required; 2 excused days: 1 day required; 3 or more excused days: no fine for that week). A week's fines are generated only after the 4-day logging window following Sunday has closed."],
  ["Valid reasons for exemption", "Illness or injury, approved leave, official travel or extended site work, family emergency, or medical advice. The participant must inform the coordinator in advance or within 24 hours. The coordinator may ask for reasonable supporting details. Each excused day lowers that week's required days by one, as set out under Penalty for non-compliance."],
  ["Collection and use of fines", "Fines will be collected by the coordinator at the end of each week or month and recorded transparently in a shared register. The collected amount will be used only for group fitness activities, rewards for top performers, or a tea party by the group."],
  ["Honesty and fair play", "False, copied or manipulated entries will attract a fine of ₹100 per instance."],
  ["Health and safety", "Participants must exercise within their personal fitness limits, stay hydrated, warm up and cool down properly, and stop immediately if they feel pain, dizziness or discomfort. Participants with a medical condition should consult a doctor before taking part."],
  ["Personal responsibility", "Exercise is undertaken during the participant’s personal time and at their own risk. Aarvee Engineers shall not be held liable for any injury, illness or loss arising from personal exercise activities."],
  ["Recognition", "Participants with consistent participation will be recognised monthly (e.g., “Fitness Champion of the Month”), at the discretion of the organising team."],
  ["Amendments", "The organising team may revise these rules with at least 7 days’ notice to all participants. The coordinator’s decision on any dispute shall be final."],
];

const PEOPLE = [["Program Manager", "Sneha"], ["Program Coordinator", "Vikash, Sunanda"], ["Fine Collector", "Sridhar"]];

function termsView() {
  return shell(`<main class="page single"><section class="card terms" aria-label="Terms and conditions">
    <h2>About the Programme</h2>
    <p>An internal wellness initiative that encourages every member to build a consistent daily habit of physical activity. Every employee who joins this group commits to a minimum of 30 minutes of dedicated physical exercise on at least 5 days every week. Once enrolled, this commitment is mandatory for the duration of the programme.</p>
    <h2>Terms &amp; Conditions</h2>
    <ul>${TERMS.map(([t, body]) => `<li><strong>${esc(t)}:</strong> ${esc(body)}</li>`).join("")}</ul>
    <h2>Responsible Personnel</h2>
    <dl class="people">${PEOPLE.map(([role, names]) => `<div><dt>${esc(role)}</dt><dd>${esc(names)}</dd></div>`).join("")}</dl></section></main>`, {
    eyebrow: "Terms &amp; Conditions",
    title: "Terms &amp; Conditions",
    sub: "“30 Minutes a Day for a Healthier Aarvee”",
  });
}

// ---------------------------------------------------------------- coordinator: members

function membersView() {
  const issued = state.issued
    ? `<section class="card" aria-label="New credentials"><h2>New accounts</h2>
        <p class="hint">Passwords are shown only now. Copy them and share each one privately; members can change theirs after signing in.</p>
        <textarea id="issued" readonly rows="${Math.min(12, state.issued.rows + 1)}">${esc(state.issued.text)}</textarea>
        <div class="row mt10"><button class="btn small" data-action="copy-issued">Copy</button>
        <button class="btn ghost small" data-action="dismiss-issued">Done</button></div></section>`
    : "";
  const rows = (state.members || []).map((m) => `<tr>
      <td><button class="link-btn" data-action="view-member" data-id="${m.id}" title="View activity log">${esc(m.name)}</button> ${m.is_root ? '<span class="tag">Admin</span>' : m.is_admin ? '<span class="tag">Coordinator</span>' : ""}${m.participates ? "" : ' <span class="tag">Not ranked</span>'}</td><td class="muted">${esc(m.email)}</td>
      <td>${m.today_minutes >= 30 ? '<span class="tag ok">✓ ' + m.today_minutes + " min</span>" : m.today_minutes ? m.today_minutes + " min" : "–"}</td>
      <td>${m.week_done}/5</td><td>🔥 ${m.streak}</td><td>${m.last_log ? fmtDate(m.last_log) : "Never"}</td>
      <td>${m.active ? "" : '<span class="tag">Inactive</span>'}</td>
      <td class="actions">${m.is_root ? (state.me.user.is_root ? `<button class="btn ghost small" data-action="reset-pw" data-id="${m.id}" data-name="${esc(m.name)}">Reset password</button>` : "") : `<button class="btn ghost small" data-action="reset-pw" data-id="${m.id}" data-name="${esc(m.name)}">Reset password</button>
      <button class="btn ghost small" data-action="toggle-role" data-id="${m.id}" data-admin="${m.is_admin ? 0 : 1}">${m.is_admin ? "Remove coordinator" : "Make coordinator"}</button>
      <button class="btn ghost small" data-action="toggle-active" data-id="${m.id}" data-active="${m.active ? 0 : 1}">${m.active ? "Deactivate" : "Reactivate"}</button>`}</td></tr>`).join("");
  return shell(`<main class="page single"><div class="stack">
    ${issued}
    <section class="card" aria-label="Add members"><h2>Add members</h2>
      <form data-form="bulk"><label for="bulk">One member per line: Full Name, email</label>
      <textarea id="bulk" name="text" placeholder="Ravi Kumar, ravi.kumar@aarvee.net&#10;Priya Nair, priya.nair@aarvee.net" required></textarea>
      <p class="hint">Members sign in with their email. Name and email can be in either order.</p>
      <p class="error" role="alert"></p>
      <button class="btn" type="submit">Create accounts</button></form></section>
    <section class="card" aria-label="Members"><h2>Members (${(state.members || []).length})</h2>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Today</th><th>This week</th><th>Streak</th><th>Last logged</th><th></th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div></section></div></main>`, {
    eyebrow: "Admin",
    title: "Members",
    sub: "Create accounts, reset passwords and manage coordinator access. Click a member's name to see their activity log.",
  });
}

function memberLogModal(m) {
  const byDate = new Map();
  for (const e of m.logs) byDate.set(e.date, [...(byDate.get(e.date) || []), e]);
  const days = [...byDate].map(([date, es]) => `<h3>${esc(fmtDate(date))} · ${fmtMins(es.reduce((n, e) => n + e.minutes, 0))}</h3>
    <ul class="entries">${es.map((e) => `<li><div class="grow"><strong>${esc(e.activity)}</strong>${e.note ? `<div class="note">${esc(e.note)}</div>` : ""}</div>
      <span>${e.minutes} min</span><span class="when">${fmtTime(e.at)}</span></li>`).join("")}</ul>`).join("");
  const pending = m.pending.length
    ? `<h3>Awaiting approval</h3><ul class="entries">${m.pending.map((r) => `<li><div class="grow"><strong>${esc(r.activity)}</strong> <span class="muted">· ${esc(fmtDate(r.date))}</span>
        <div class="note">${esc(r.reason)}</div></div><span>${r.minutes} min</span></li>`).join("")}</ul>`
    : "";
  const st = m.stats;
  showModal(`<h2>${esc(m.name)}</h2>
    <p class="muted">${esc(m.email)}</p>
    <div>${pips(m.week.map((x) => x.status))} <strong>${st.week_done}/5</strong> this week · 🔥 ${st.current_streak} streak · ${plural(st.active_days, "active day")} · ${fmtMins(st.total_minutes)} total</div>
    ${pending}
    ${days || '<p class="hint">No activity logged yet.</p>'}
    <div class="row mt16"><button class="btn" data-action="close-modal">Close</button></div>`, { formClass: "wide" });
}

// ---------------------------------------------------------------- coordinator: leave / exemptions

function leaveView() {
  const L = state.leave;
  const people = (state.members || []).filter((m) => m.active && m.participates);
  const todayIso = state.me.today.date;
  const rows = L.items.map((x) => `<tr><td>${fmtDate(x.date)}</td><td>${esc(x.name)} <span class="muted">${esc(x.email)}</span></td>
      <td>${esc(x.reason)}</td><td><button class="btn danger small" data-action="del-leave" data-id="${x.user_id}" data-date="${x.date}">Remove</button></td></tr>`).join("");
  return shell(`<main class="page single"><div class="stack">
    <section class="card" aria-label="Mark leave"><h2>Mark valid-reason days</h2>
      <p class="hint">Each excused day lowers the ${state.me.config.min_days} days a member must complete that week by one (${state.me.config.min_days}+ excused days = no fine). Excused days don't break the streak or count toward a perfect week.</p>
      <form data-form="leave"><div class="form-grid">
        <div class="full"><label for="lv-user">Member</label><select id="lv-user" name="user_id" required>
          ${people.map((m) => `<option value="${m.id}">${esc(m.name)} (${esc(m.email)})</option>`).join("")}</select></div>
        <div><label for="lv-from">From</label><input id="lv-from" name="from" type="date" value="${todayIso}" required></div>
        <div><label for="lv-to">To</label><input id="lv-to" name="to" type="date" value="${todayIso}" required></div>
        <div class="full"><label for="lv-reason">Reason</label><select id="lv-reason" name="reason" required>
          ${L.reasons.map((r) => `<option>${esc(r)}</option>`).join("")}</select></div>
        <div class="full" id="lv-other-wrap" hidden><label for="lv-other">Please mention the reason</label>
          <input id="lv-other" name="other" maxlength="${L.other_max}" placeholder="e.g. Wedding in the family, Court hearing" disabled required></div></div>
      <p class="error" role="alert"></p>
      <button class="btn" type="submit">Mark as excused</button></form></section>
    <section class="card" aria-label="Recorded leave"><h2>Recorded (last 45 days onwards)</h2>
      <div class="table-wrap"><table><thead><tr><th>Date</th><th>Member</th><th>Reason</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4" class="muted">Nothing recorded.</td></tr>'}</tbody></table></div></section>
  </div></main>`, {
    eyebrow: "Admin",
    title: "Leave &amp; excused days",
    sub: "Each day marked here reduces the days a member must complete that week and doesn't break their streak.",
  });
}

// ---------------------------------------------------------------- coordinator: late-entry requests

function requestsView() {
  const items = state.requests.items;
  const pending = items.filter((x) => x.status === "pending");
  const row = (x) => `<tr><td>${fmtDate(x.date)}</td><td>${esc(x.name)} <span class="muted">${esc(x.email)}</span></td>
      <td>${esc(x.activity)}${x.note ? `<div class="note">${esc(x.note)}</div>` : ""}</td><td>${x.minutes} min</td><td>${esc(x.reason)}</td>
      <td class="actions">${x.status === "pending"
        ? `<button class="btn small" data-action="decide-req" data-id="${x.id}" data-ok="1">Approve</button>
           <button class="btn danger small" data-action="decide-req" data-id="${x.id}" data-ok="0">Reject</button>`
        : REQ_TAG[x.status]}</td></tr>`;
  const head = "<thead><tr><th>Date</th><th>Member</th><th>Activity</th><th>Duration</th><th>Reason</th><th></th></tr></thead>";
  const decided = items.filter((x) => x.status !== "pending");
  const leaveRow = (x) => `<tr><td>${esc(fmtRange(x.from, x.to))}<div class="note">${plural(x.days, "day")}</div></td>
      <td>${esc(x.name)} <span class="muted">${esc(x.email)}</span></td><td>${esc(x.reason)}</td>
      <td class="actions">${x.status === "pending"
        ? `<button class="btn small" data-action="decide-leave" data-id="${x.id}" data-ok="1">Approve</button>
           <button class="btn danger small" data-action="decide-leave" data-id="${x.id}" data-ok="0">Reject</button>`
        : REQ_TAG[x.status]}</td></tr>`;
  const leaveHead = "<thead><tr><th>Dates</th><th>Member</th><th>Reason</th><th></th></tr></thead>";
  const leavePending = state.requests.leave.filter((x) => x.status === "pending");
  const leaveDecided = state.requests.leave.filter((x) => x.status !== "pending");
  return shell(`<main class="page single"><div class="stack">
    <section class="card" aria-label="Pending leave requests"><h2>Leave requests (${leavePending.length})</h2>
      <p class="hint">Approving marks every day in the range as excused for that member (same as the Leave tab).</p>
      <div class="table-wrap"><table>${leaveHead}
      <tbody>${leavePending.map(leaveRow).join("") || '<tr><td colspan="4" class="muted">Nothing waiting.</td></tr>'}</tbody></table></div></section>
    ${leaveDecided.length ? `<section class="card" aria-label="Decided leave requests"><h2>Decided leave (last 30 days)</h2>
      <div class="table-wrap"><table>${leaveHead}<tbody>${leaveDecided.map(leaveRow).join("")}</tbody></table></div></section>` : ""}
    <section class="card" aria-label="Pending requests"><h2>Late-entry requests (${pending.length})</h2>
      <p class="hint">Members can log today and the previous ${state.me.config.log_back_days} days directly. Anything older comes here. Approved entries count from then on, so they can change past week results and fines.</p>
      <div class="table-wrap"><table>${head}
      <tbody>${pending.map(row).join("") || '<tr><td colspan="6" class="muted">Nothing waiting.</td></tr>'}</tbody></table></div></section>
    ${decided.length ? `<section class="card" aria-label="Decided requests"><h2>Decided (last 30 days)</h2>
      <div class="table-wrap"><table>${head}<tbody>${decided.map(row).join("")}</tbody></table></div></section>` : ""}
  </div></main>`, {
    eyebrow: "Admin",
    title: "Requests",
    sub: "Approve or reject leave applications and activities logged after the logging window closed.",
  });
}

// ---------------------------------------------------------------- coordinator: fine report

function reportView() {
  const R = state.report;
  const rows = R.rows.map((r) => `<tr class="${r.fine ? "fined" : ""}"><td>${esc(r.name)}</td><td class="muted">${esc(r.email)}</td>
      <td>${pips(r.days)}</td><td>${r.done}</td><td>${r.excused}</td><td>${r.short || "–"}</td>
      <td>${r.fine ? "<strong>₹" + r.fine + "</strong>" : "–"}</td></tr>`).join("");
  const finedCount = R.rows.filter((r) => r.fine).length;
  return shell(`<main class="page single"><section class="card" aria-label="Fine report">
    <div class="row spread"><h2>Week summary</h2>
      <div class="row"><button class="btn ghost small" data-action="week-nav" data-d="-7">◀ Prev</button>
      <strong>Week of ${fmtDate(R.week, { day: "numeric", month: "short", year: "numeric" })}</strong>
      <button class="btn ghost small" data-action="week-nav" data-d="7" ${R.can_next ? "" : "disabled"}>Next ▶</button></div></div>
    <p class="hint">₹${R.fine_per_week} applies when done days fall short of ${R.min_days} minus the member's excused days (Leave tab) in the week (Mon–Sun). With ${R.min_days}+ excused days there is no fine. "Short by" is the days still needed. The ₹100 false-entry fine is not automated.</p>
    ${R.provisional ? `<p class="notice mt10">Fines for this week are not generated yet. Members can still log activity (including Sunday) until ${fmtDate(isoShift(R.final_on, -1))}; fines appear from ${fmtDate(R.final_on)}.</p>` : ""}
    <div class="table-wrap mt10"><table><thead><tr><th>Member</th><th>Email</th><th>Mon–Sun</th><th>Done</th><th>Excused</th><th>Short by</th><th>Fine</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="7" class="muted">No members yet.</td></tr>'}</tbody></table></div>
    <div class="row spread mt16"><strong>Total: ₹${R.total_fine} (${plural(finedCount, "member")})</strong>
      <button class="btn small" data-action="export-report">Export CSV</button></div>
  </section></main>`, {
    eyebrow: "Admin",
    title: "Weekly fine report",
    sub: `₹${R.fine_per_week} per member who completes fewer than ${R.min_days} days in a week (less 1 per excused day).`,
  });
}

function exportReport() {
  const R = state.report;
  const cell = (v) => {
    let s = String(v);
    if (/^[=+\-@]/.test(s)) s = "'" + s; // stop spreadsheet formula injection from names
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [["Name", "Email", "Days done", "Excused", "Short by", "Fine (INR)"]]
    .concat(R.rows.map((r) => [r.name, r.email, r.done, r.excused, r.short, r.fine]));
  const blob = new Blob([lines.map((l) => l.map(cell).join(",")).join("\r\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `november-fitness-challenge-week-${R.week}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------- data + render

function render() {
  if (!state.me) { app.innerHTML = loginView(); return; }
  const views = { home: homeView, board: boardView, terms: termsView, members: membersView, leave: leaveView, requests: requestsView, report: reportView };
  app.innerHTML = (views[state.view] || homeView)();
}

async function loadViewData() {
  state.me = await api("GET", "/api/me");
  const v = state.view;
  if (v === "board") state.board = await api("GET", "/api/leaderboard?period=" + state.boardPeriod);
  if (v === "members" || v === "leave") state.members = (await api("GET", "/api/admin/members")).members;
  if (v === "leave") state.leave = await api("GET", "/api/admin/exemptions");
  if (v === "requests") state.requests = await api("GET", "/api/admin/log-requests");
  if (v === "report") state.report = await api("GET", "/api/admin/report?week=" + encodeURIComponent(state.reportWeek));
}
async function refresh() {
  await loadViewData();
  render();
}

// ---------------------------------------------------------------- events

// On document, not app: modal forms (change password) are appended to <body>, outside #app.
document.addEventListener("submit", async (e) => {
  const form = e.target.closest("[data-form]");
  if (!form) return;
  e.preventDefault();
  const kind = form.dataset.form;
  const btn = form.querySelector("button[type=submit]");
  const fd = Object.fromEntries(new FormData(form));
  const err = form.querySelector(".error");
  err.textContent = "";
  btn.disabled = true;
  try {
    if (kind === "login") {
      state.view = "home";
      await api("POST", "/api/login", fd);
      await refresh();
      ensureGuard();
    } else if (kind === "log") {
      const wasMet = state.me.today.met;
      const res = await api("POST", "/api/logs", fd);
      await refresh();
      if (res.requested) toast(`Sent to admin for approval: ${fd.minutes} min on ${fmtDate(fd.date)}`);
      else if (res.celebration) celebrate(res.celebration);
      else if (!wasMet && state.me.today.met) toast("Today's goal complete — nice work!");
      else toast(`Logged ${fd.minutes} min of ${fd.other || fd.activity}${fd.date !== state.me.today.date ? " on " + fmtDate(fd.date) : ""}`);
    } else if (kind === "bulk") {
      const { results } = await api("POST", "/api/admin/members/bulk", fd);
      const ok = results.filter((r) => r.status === "created");
      const bad = results.filter((r) => r.status === "error");
      state.issued = ok.length
        ? { rows: ok.length, text: "Name, Email, Password\n" + ok.map((r) => `${r.name}, ${r.email}, ${r.password}`).join("\n") }
        : null;
      await refresh();
      if (bad.length) document.querySelector("[data-form=bulk] .error").textContent = "Skipped: " + bad.map((r) => `${r.email || r.line} (${r.detail})`).join("; ");
    } else if (kind === "leave") {
      const { added } = await api("POST", "/api/admin/exemptions", fd);
      await refresh();
      toast(`${plural(added, "day")} marked as excused`);
    } else if (kind === "leave-request") {
      await api("POST", "/api/leave-requests", fd);
      await refresh();
      toast("Leave request sent for approval");
    } else if (kind === "password") {
      await api("POST", "/api/password", fd);
      closeModal();
      toast("Password changed");
    }
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    btn.disabled = false;
  }
});

app.addEventListener("change", (e) => {
  if (e.target.id === "lv-reason" || e.target.id === "lr-reason") {
    const p = e.target.id === "lv-reason" ? "lv" : "lr";
    const isOther = e.target.value === "Other";
    document.getElementById(p + "-other-wrap").hidden = !isOther;
    const input = document.getElementById(p + "-other");
    input.disabled = !isOther;
    if (isOther) input.focus();
    return;
  }
  if (e.target.id === "lr-from") {
    const to = document.getElementById("lr-to");
    if (to.value < e.target.value) to.value = e.target.value;
    return;
  }
  if (e.target.id === "log-date") {
    // Dates before the open window become an approval request and need a reason.
    const late = !!e.target.value && e.target.value < state.me.config.log_open_from;
    document.getElementById("reason-wrap").hidden = !late;
    document.getElementById("reason").disabled = !late;
    document.getElementById("log-submit").textContent = late ? "Send for approval" : "Log activity";
    return;
  }
  if (e.target.id !== "activity") return;
  const isOther = e.target.value === state.me.config.other_activity;
  const wrap = document.getElementById("other-wrap");
  const input = document.getElementById("other");
  wrap.hidden = !isOther;
  input.disabled = !isOther; // disabled fields skip validation and aren't submitted
  if (isOther) input.focus();
});

app.addEventListener("input", (e) => {
  if (e.target.id !== "minutes") return;
  document.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.m === e.target.value)));
});

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const a = el.dataset.action, d = el.dataset;
  try {
    if (a === "close-modal") closeModal();
    else if (a === "theme") {
      const next = isDark() ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem("theme", next); } catch {}
      syncThemeBtns();
    }
    else if (a === "toggle-pw") {
      const input = el.previousElementSibling, show = input.type === "password";
      input.type = show ? "text" : "password";
      el.textContent = show ? "Hide" : "Show";
      el.setAttribute("aria-pressed", String(show));
      el.setAttribute("aria-label", show ? "Hide password" : "Show password");
      input.focus();
    }
    else if (a === "nav") {
      if (d.view === state.view) return;
      ensureGuard();
      // Going back to My profile = stepping back in history, so the stack stays [root, home, tab].
      if (d.view === "home" && inApp() && history.state.view !== "home") { history.back(); return; }
      const entry = { g: "app", view: d.view };
      if (state.view === "home") history.pushState(entry, ""); else history.replaceState(entry, "");
      state.view = d.view;
      await refresh();
    }
    else if (a === "period") { state.boardPeriod = d.p; await refresh(); }
    else if (a === "logout") await signOut();
    else if (a === "signout") { closeModal(); await signOut(); }
    else if (a === "chip") {
      const input = document.getElementById("minutes");
      input.value = d.m;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    } else if (a === "delete-log") {
      if (!confirm("Delete this entry?")) return;
      await api("DELETE", "/api/logs/" + d.id);
      await refresh();
    } else if (a === "change-pw") {
      showModal(`<form data-form="password"><h2>Change password</h2>
        <label for="cur">Current password</label>${pwField('id="cur" name="current" autocomplete="current-password" required')}
        <label for="new">New password (8+ characters)</label>${pwField('id="new" name="new" autocomplete="new-password" minlength="8" required')}
        <p class="error" role="alert"></p>
        <div class="row mt16"><button class="btn" type="submit">Save</button>
        <button class="btn ghost" type="button" data-action="close-modal">Cancel</button></div></form>`, { formClass: "form" });
    } else if (a === "reset-pw") {
      if (!confirm(`Reset the password for ${d.name}? They will be signed out.`)) return;
      const { password } = await api("POST", `/api/admin/members/${d.id}/reset`);
      showModal(`<h2>New password</h2><p>For ${esc(d.name)} — shown only once:</p>
        <p class="mono pw-big">${esc(password)}</p><button class="btn" data-action="close-modal">Close</button>`);
    } else if (a === "view-week") {
      weekActivityModal(await api("GET", `/api/leaderboard/${d.id}/week`));
    } else if (a === "view-member") {
      memberLogModal(await api("GET", `/api/admin/members/${d.id}/logs`));
    } else if (a === "toggle-active") {
      await api("POST", `/api/admin/members/${d.id}/active`, { active: d.active === "1" });
      await refresh();
    } else if (a === "toggle-role") {
      await api("POST", `/api/admin/members/${d.id}/role`, { is_admin: d.admin === "1" });
      await refresh();
    } else if (a === "del-leave") {
      await api("DELETE", `/api/admin/exemptions/${d.id}/${d.date}`);
      await refresh();
    } else if (a === "cancel-leave") {
      if (!confirm("Cancel this leave request?")) return;
      await api("DELETE", "/api/leave-requests/" + d.id);
      await refresh();
    } else if (a === "decide-leave") {
      const ok = d.ok === "1";
      if (!ok && !confirm("Reject this leave request?")) return;
      await api("POST", "/api/admin/leave-requests/" + d.id, { approve: ok });
      await refresh();
      toast(ok ? "Approved — days marked as excused" : "Leave request rejected");
    } else if (a === "decide-req") {
      const ok = d.ok === "1";
      if (!ok && !confirm("Reject this request?")) return;
      await api("POST", "/api/admin/log-requests/" + d.id, { approve: ok });
      await refresh();
      toast(ok ? "Approved — entry added" : "Request rejected");
    } else if (a === "week-nav") {
      state.reportWeek = isoShift(state.report.week, Number(d.d));
      await refresh();
    } else if (a === "export-report") {
      exportReport();
    } else if (a === "copy-issued") {
      const ta = document.getElementById("issued");
      ta.select();
      // navigator.clipboard needs HTTPS; this app is usually served over plain HTTP on the LAN.
      toast(document.execCommand("copy") ? "Copied" : "Press Ctrl+C to copy");
    } else if (a === "dismiss-issued") {
      state.issued = null;
      render();
    }
  } catch (ex) {
    toast(ex.message);
  }
});

// ---------------------------------------------------------------- browser Back button
// History while signed in: [<previous site>, root, app]. The page lives on "app". Back from a tab
// lands on My profile; Back from My profile hits "root", which asks to sign out instead of leaving.
// Signing out steps back onto "root", so the next Back goes to the previous site.

const inApp = () => !!history.state && history.state.g === "app";

function ensureGuard() {
  if (!state.me) return;
  if (inApp()) {
    if (history.state.view !== state.view) history.replaceState({ g: "app", view: state.view }, "");
    return;
  }
  history.replaceState({ g: "root" }, "");
  history.pushState({ g: "app", view: state.view }, "");
}

async function signOut() {
  await api("POST", "/api/logout");
  const depth = inApp() ? (history.state.view === "home" ? 1 : 2) : 0;
  state.me = null; state.issued = null;
  render();
  if (depth) history.go(-depth);
}

window.addEventListener("popstate", async (e) => {
  const s = e.state;
  if (!state.me || !s) return; // signed out (login page) or an entry we didn't create
  closeModal();
  if (s.g === "root") {
    history.pushState({ g: "app", view: state.view }, ""); // stay on the page; the dialog decides
    showModal(`<h2>Sign out?</h2><p class="hint">You'll return to the sign-in page.</p>
      <div class="row mt16"><button class="btn" data-action="close-modal">Stay signed in</button>
      <button class="btn danger" data-action="signout">Sign out</button></div>`, { formClass: "form" });
  } else if (s.g === "app") {
    state.view = s.view || "home";
    try { await refresh(); } catch (ex) { toast(ex.message); }
  }
});

(async function init() {
  if (inApp()) state.view = history.state.view || "home"; // reload on a tab keeps that tab
  try { await loadViewData(); } catch { state.me = null; }
  render();
  // Browsers skip history entries added before the user has touched the page, so arm on first interaction.
  for (const ev of ["pointerdown", "keydown"]) document.addEventListener(ev, ensureGuard, { once: true });
})();
