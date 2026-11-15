// Personal reminder assistant — Cloudflare Worker
// Serves the mobile web app, stores data in KV, and runs a cron every 5 minutes
// that sends push notifications through ntfy (https://ntfy.sh).

import APP_HTML from "./app.html";
import { ICON_PNG_B64 } from "./icon.js";

const DAY = 86400000;

const DEFAULT_STATE = () => ({
  settings: {
    tz: "Asia/Jerusalem",
    pillTime: "08:00",
    pillRepeatMin: 15,
    gymDays: [1, 2, 4], // 0=Sun … 6=Sat  → Mon, Tue, Thu
    gymTime: "21:30",
    appUrl: "",
  },
  pills: { takenDate: null, takenAt: 0, lastNagAt: 0, snoozeUntil: 0, nagDate: null, nagCount: 0 },
  gym: { remindedDate: null, overrides: {} }, // overrides: { "2026-11-17": true|false }
  shows: [],
  notes: [],
});

// ---------- storage ----------
async function load(env) {
  const s = await env.DATA.get("state", "json");
  const d = DEFAULT_STATE();
  if (!s) return d;
  return {
    ...d,
    ...s,
    settings: { ...d.settings, ...s.settings },
    pills: { ...d.pills, ...s.pills },
    gym: { ...d.gym, ...s.gym, overrides: { ...(s.gym?.overrides || {}) } },
    shows: s.shows || [],
    notes: s.notes || [],
  };
}
const save = (env, s) => env.DATA.put("state", JSON.stringify(s));

// ---------- time helpers ----------
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function local(tz, date = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
    }).formatToParts(date).map((x) => [x.type, x.value])
  );
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}`, weekday: WD.indexOf(p.weekday) };
}
function gymTomorrow(s, now) {
  const t = local(s.settings.tz, new Date(now + DAY));
  const o = s.gym.overrides[t.date];
  const isGym = typeof o === "boolean" ? o : s.settings.gymDays.includes(t.weekday);
  return { date: t.date, weekday: t.weekday, isGym, overridden: typeof o === "boolean" };
}

// ---------- notifications ----------
async function notify(env, msg) {
  if (!env.NTFY_TOPIC) { console.log("NTFY_TOPIC not set; skipping", msg.title); return false; }
  const headers = { "Content-Type": "application/json" };
  if (env.NTFY_TOKEN) headers.Authorization = `Bearer ${env.NTFY_TOKEN}`;
  try {
    const r = await fetch(env.NTFY_SERVER || "https://ntfy.sh", {
      method: "POST", headers, body: JSON.stringify({ topic: env.NTFY_TOPIC, ...msg }),
    });
    if (!r.ok) console.log("ntfy error", r.status, await r.text());
    return r.ok;
  } catch (e) { console.log("ntfy fetch failed", String(e)); return false; }
}
const ackUrl = (s, env, path) => `${s.settings.appUrl}/ack/${path}${path.includes("?") ? "&" : "?"}k=${encodeURIComponent(env.ACK_KEY || "")}`;
const btn = (label, url) => ({ action: "http", label, url, method: "POST", clear: true });

// ---------- the 5-minute check ----------
async function tick(env, now = Date.now()) {
  const s = await load(env);
  const { settings } = s;
  const L = local(settings.tz, new Date(now));
  const base = settings.appUrl;
  let changed = false;

  // 1) Pills — nag every N minutes from pillTime until marked taken (resets daily)
  const p = s.pills;
  const intervalMs = Math.max(1, settings.pillRepeatMin) * 60000 - 30000; // 30s slack for cron jitter
  if (settings.pillTime && p.takenDate !== L.date && L.hm >= settings.pillTime &&
      now >= (p.snoozeUntil || 0) && now - (p.lastNagAt || 0) >= intervalMs) {
    const n = p.nagDate === L.date ? p.nagCount + 1 : 1;
    const ok = await notify(env, {
      title: "💊 Take your pills",
      message: n === 1 ? "Time for your pills. Tap Taken once you've had them." : `Reminder #${n}: still not marked as taken.`,
      priority: n >= 4 ? 5 : 4,
      tags: ["pill"],
      click: base ? `${base}/#today` : undefined,
      actions: base ? [btn("Taken ✅", ackUrl(s, env, "pills")), btn("Snooze 30m", ackUrl(s, env, "pills-snooze?min=30"))] : undefined,
    });
    if (ok) { Object.assign(p, { lastNagAt: now, nagDate: L.date, nagCount: n }); changed = true; }
  }

  // 2) Gym — once, the evening before a workout day
  const g = gymTomorrow(s, now);
  if (g.isGym && settings.gymTime && L.hm >= settings.gymTime && s.gym.remindedDate !== L.date) {
    const ok = await notify(env, {
      title: "🏋️ Gym tomorrow",
      message: `Workout on ${WD[g.weekday]}: pack your gym clothes tonight (shoes, towel, water bottle).`,
      priority: 4, tags: ["muscle"], click: base ? `${base}/#today` : undefined,
    });
    if (ok) { s.gym.remindedDate = L.date; changed = true; }
  }

  // 3) Notes with a reminder time
  for (const note of s.notes) {
    if (note.done || note.reminded || !note.remindAt || Date.parse(note.remindAt) > now) continue;
    const ok = await notify(env, {
      title: "📝 You asked me to remind you",
      message: note.text.slice(0, 1000),
      priority: 4, tags: ["memo"], click: base ? `${base}/#notes` : undefined,
      actions: base ? [btn("Done ✅", ackUrl(s, env, `note?id=${note.id}`)), btn("Remind in 1h", ackUrl(s, env, `note-snooze?id=${note.id}&min=60`))] : undefined,
    });
    if (ok) { note.reminded = true; changed = true; }
  }

  // housekeeping: drop gym overrides older than today
  for (const d of Object.keys(s.gym.overrides)) if (d < L.date) { delete s.gym.overrides[d]; changed = true; }

  if (changed) await save(env, s);
  return s;
}

// ---------- state changes from the app ----------
const uid = () => crypto.randomUUID().slice(0, 8);
const str = (v, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");
const isHM = (v) => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

function applyOp(s, op, d = {}, now = Date.now()) {
  const today = local(s.settings.tz, new Date(now)).date;
  switch (op) {
    case "pills.taken": Object.assign(s.pills, { takenDate: today, takenAt: now, snoozeUntil: 0 }); break;
    case "pills.undo": Object.assign(s.pills, { takenDate: null, takenAt: 0, lastNagAt: 0 }); break;
    case "pills.snooze": s.pills.snoozeUntil = now + Math.min(Math.max(+d.min || 30, 1), 720) * 60000; break;

    case "settings": {
      const st = s.settings;
      if (d.pillTime === "" || isHM(d.pillTime)) st.pillTime = d.pillTime;
      if (+d.pillRepeatMin >= 5 && +d.pillRepeatMin <= 240) st.pillRepeatMin = +d.pillRepeatMin;
      if (Array.isArray(d.gymDays)) st.gymDays = [...new Set(d.gymDays.map(Number).filter((x) => x >= 0 && x <= 6))].sort();
      if (d.gymTime === "" || isHM(d.gymTime)) st.gymTime = d.gymTime;
      if (typeof d.tz === "string") { try { local(d.tz); st.tz = d.tz; } catch { throw new Error("Unknown time zone"); } }
      break;
    }
    case "gym.override":
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) throw new Error("bad date");
      if (typeof d.value === "boolean") s.gym.overrides[d.date] = d.value; else delete s.gym.overrides[d.date];
      break;

    case "show.save": {
      const title = str(d.title, 120).trim();
      if (!title) throw new Error("Title is required");
      const fields = {
        title, platform: str(d.platform, 60), note: str(d.note, 300),
        season: Math.max(0, parseInt(d.season) || 0), episode: Math.max(0, parseInt(d.episode) || 0),
        status: ["watching", "paused", "finished"].includes(d.status) ? d.status : "watching", updatedAt: now,
      };
      const ex = s.shows.find((x) => x.id === d.id);
      if (ex) Object.assign(ex, fields); else s.shows.unshift({ id: uid(), createdAt: now, ...fields });
      break;
    }
    case "show.next": { const x = s.shows.find((x) => x.id === d.id); if (x) { x.episode = (x.episode || 0) + 1; x.updatedAt = now; } break; }
    case "show.delete": s.shows = s.shows.filter((x) => x.id !== d.id); break;

    case "note.save": {
      const text = str(d.text, 4000).trim();
      if (!text) throw new Error("Note is empty");
      const remindAt = d.remindAt && !isNaN(Date.parse(d.remindAt)) ? new Date(d.remindAt).toISOString() : null;
      const ex = s.notes.find((x) => x.id === d.id);
      if (ex) { if (ex.remindAt !== remindAt) ex.reminded = false; Object.assign(ex, { text, remindAt, updatedAt: now }); }
      else s.notes.unshift({ id: uid(), text, remindAt, reminded: false, done: false, createdAt: now });
      break;
    }
    case "note.done": { const x = s.notes.find((x) => x.id === d.id); if (x) x.done = !!d.done; break; }
    case "note.delete": s.notes = s.notes.filter((x) => x.id !== d.id); break;
    default: throw new Error("Unknown op");
  }
}

function view(s, now = Date.now()) {
  const L = local(s.settings.tz, new Date(now));
  return { ...s, now, today: L.date, nowHM: L.hm, pillsTakenToday: s.pills.takenDate === L.date, gymTomorrow: gymTomorrow(s, now) };
}

// ---------- HTTP ----------
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
function safeEq(a = "", b = "") {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const MANIFEST = {
  name: "Reminders", short_name: "Reminders", start_url: "/", display: "standalone",
  background_color: "#141826", theme_color: "#141826",
  icons: [{ src: "/icon.png", sizes: "180x180", type: "image/png" }],
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/" || path === "/index.html")
      return new Response(APP_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    if (path === "/manifest.webmanifest") return json(MANIFEST);
    if (path === "/icon.png")
      return new Response(Uint8Array.from(atob(ICON_PNG_B64), (c) => c.charCodeAt(0)), { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } });

    // Notification buttons (ntfy calls these). Protected by ACK_KEY.
    if (path.startsWith("/ack/")) {
      if (!safeEq(url.searchParams.get("k") || "", env.ACK_KEY)) return new Response("Forbidden", { status: 403 });
      const s = await load(env);
      const min = +url.searchParams.get("min") || 60, id = url.searchParams.get("id");
      const action = path.slice(5);
      if (action === "pills") applyOp(s, "pills.taken");
      else if (action === "pills-snooze") applyOp(s, "pills.snooze", { min });
      else if (action === "note") applyOp(s, "note.done", { id, done: true });
      else if (action === "note-snooze") {
        const n = s.notes.find((x) => x.id === id);
        if (n) { n.remindAt = new Date(Date.now() + min * 60000).toISOString(); n.reminded = false; }
      } else if (action !== "ping") return new Response("Not found", { status: 404 });
      await save(env, s);
      return new Response("Done ✔ You can close this.", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    if (path.startsWith("/api/")) {
      const auth = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      if (!safeEq(auth, env.APP_TOKEN)) return json({ error: "unauthorized" }, 401);
      let s = await load(env);
      // Remember the public URL so cron notifications can link back to the app
      if (s.settings.appUrl !== url.origin) { s.settings.appUrl = url.origin; await save(env, s); }

      if (path === "/api/state" && req.method === "GET") return json(view(s));
      if (path === "/api/op" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        try { applyOp(s, body.op, body.data); } catch (e) { return json({ error: e.message }, 400); }
        await save(env, s);
        return json(view(s));
      }
      if (path === "/api/test" && req.method === "POST") {
        const ok = await notify(env, {
          title: "✅ Reminders are working", message: "This is a test notification from your reminder app.",
          tags: ["tada"], click: `${url.origin}/`, actions: [btn("Test button", ackUrl(s, env, "ping"))],
        });
        return json({ ok, topicSet: !!env.NTFY_TOPIC });
      }
      if (path === "/api/tick" && req.method === "POST") return json(view(await tick(env)));
      return json({ error: "not found" }, 404);
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env, event.scheduledTime || Date.now()));
  },
};

