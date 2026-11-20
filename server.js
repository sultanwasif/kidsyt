import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { db, HISTORY_DAYS } from './db.js';
import {
  resolveChannel, channelVideos, getChannel,
  resolvePlaylist, playlistVideos, getPlaylist,
  resolveVideo, pickVideos, getPick
} from './youtube.js';

const {
  GOOGLE_CLIENT_ID, YT_API_KEY,
  PORT = 3100, HOST = '127.0.0.1',
  COOKIE_SECURE = 'true'
} = process.env;
if (!GOOGLE_CLIENT_ID || !YT_API_KEY) {
  console.error('Missing GOOGLE_CLIENT_ID or YT_API_KEY in .env');
  process.exit(1);
}

const SESSION_DAYS = 180;
const UNLOCK_MS = 15 * 60 * 1000;          // parent settings stay unlocked for 15 min after PIN
const FRESH_LOGIN_MS = 10 * 60 * 1000;     // a fresh Google sign-in may reset a forgotten PIN
const SESSION_COOKIE = 'kyt_sess';
const secureCookie = COOKIE_SECURE !== 'false';

const oauth = new OAuth2Client(GOOGLE_CLIENT_ID);
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use(cookieParser());
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
// Digital Asset Links for the Android (Play Store) app, so it opens full-screen without a browser bar.
// .env: TWA_PACKAGE=com.ehfservices.kidstube  TWA_SHA256=AA:BB:...,CC:DD:...  (upload key + Play app-signing key)
app.get('/.well-known/assetlinks.json', (req, res) => {
  const pkg = process.env.TWA_PACKAGE, fps = (process.env.TWA_SHA256 || '').split(',').map(s => s.trim()).filter(Boolean);
  res.json(pkg && fps.length ? [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: pkg, sha256_cert_fingerprints: fps }
  }] : []);
});
app.use(express.static('public', { extensions: ['html'] }));

/* ---------------- helpers ---------------- */
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const now = () => Date.now();

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  return 'scrypt:' + salt + ':' + crypto.scryptSync(pin, salt, 32).toString('hex');
}
function checkPin(pin, stored) {
  if (!stored) return false;
  const [, salt, hash] = stored.split(':');
  const got = crypto.scryptSync(String(pin), salt, 32);
  return crypto.timingSafeEqual(got, Buffer.from(hash, 'hex'));
}
const validPin = p => /^\d{4}$/.test(String(p || ''));

const DEFAULT_SETTINGS = {
  channels: [], playlists: [], videos: [], blockWords: [], hideShorts: true, dailyLimit: 60, perChannel: 25
};
function readSettings(parent) {
  let s = {};
  try { s = JSON.parse(parent.settings || '{}'); } catch {}
  return { ...DEFAULT_SETTINGS, ...s };
}

function dayOf(req) {
  const d = req.get('x-local-day');
  return /^\d{4}-\d{2}-\d{2}$/.test(d || '') ? d : new Date().toISOString().slice(0, 10);
}
function usageFor(parent, day) {
  const s = readSettings(parent);
  const u = db.prepare('SELECT seconds, bonus FROM usage WHERE parent_id = ? AND day = ?').get(parent.id, day) || { seconds: 0, bonus: 0 };
  const limit = s.dailyLimit > 0 ? s.dailyLimit * 60 + u.bonus : 0;
  return { seconds: u.seconds, bonus: u.bonus, limit, remaining: limit ? Math.max(0, limit - u.seconds) : null };
}

// Small fixed-window rate limiter (per key, in memory).
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const t = now();
  const b = buckets.get(key);
  if (!b || t > b.reset) { buckets.set(key, { n: 1, reset: t + windowMs }); return true; }
  return ++b.n <= max;
}
setInterval(() => { const t = now(); for (const [k, b] of buckets) if (t > b.reset) buckets.delete(k); }, 60000).unref();

const fail = (res, status, error) => res.status(status).json({ error });
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ---------------- auth ---------------- */
function auth(req, res, next) {
  const tok = req.cookies[SESSION_COOKIE];
  if (!tok) return fail(res, 401, 'Not signed in');
  const row = db.prepare(`SELECT s.token_hash, s.created_at AS session_created, p.*
    FROM sessions s JOIN parents p ON p.id = s.parent_id WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha256(tok), now());
  if (!row) return fail(res, 401, 'Session expired');
  req.parent = row;
  next();
}

// Parent unlock tokens (after PIN) — kept in memory, short-lived.
const unlocks = new Map();
function requireUnlock(req, res, next) {
  const t = req.get('x-parent-token');
  const u = t && unlocks.get(t);
  if (!u || u.exp < now() || u.parentId !== req.parent.id) return fail(res, 403, 'Parent PIN required');
  next();
}
setInterval(() => { const t = now(); for (const [k, u] of unlocks) if (u.exp < t) unlocks.delete(k); }, 60000).unref();

app.get('/api/config', (req, res) => res.json({ googleClientId: GOOGLE_CLIENT_ID }));

// Google Identity Services redirect mode posts here (works inside home-screen apps where popups fail).
app.post('/api/auth/google', wrap(async (req, res) => {
  if (!rateLimit('login:' + req.ip, 20, 10 * 60000)) return res.redirect('/?e=rate');
  const { credential, g_csrf_token } = req.body || {};
  if (!credential || !g_csrf_token || g_csrf_token !== req.cookies.g_csrf_token) return res.redirect('/?e=csrf');
  let payload;
  try {
    const ticket = await oauth.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch {
    return res.redirect('/?e=token');
  }
  if (!payload?.sub || payload.email_verified === false) return res.redirect('/?e=email');

  db.prepare(`INSERT INTO parents (google_sub, email, name, picture, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(google_sub) DO UPDATE SET email = excluded.email, name = excluded.name, picture = excluded.picture`)
    .run(payload.sub, payload.email || '', payload.name || '', payload.picture || '', now());
  const parent = db.prepare('SELECT id FROM parents WHERE google_sub = ?').get(payload.sub);

  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, parent_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), parent.id, now(), now() + SESSION_DAYS * 86400000);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true, secure: secureCookie, sameSite: 'lax', maxAge: SESSION_DAYS * 86400000, path: '/'
  });
  res.redirect('/');
}));

app.post('/api/auth/logout', auth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.parent.token_hash);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

/* ---------------- profile & settings ---------------- */
function channelInfo(ids) {
  return ids.map(getChannel).filter(Boolean).map(c => ({ id: c.id, title: c.title, thumb: c.thumb }));
}
function playlistInfo(ids) {
  return ids.map(getPlaylist).filter(Boolean).map(p => ({ id: p.id, title: p.title, thumb: p.thumb, channel: p.channel }));
}
const pickInfo = v => ({ id: v.id, title: v.title, thumb: v.thumb, channel: v.channel });
function picksInfo(ids) {
  return ids.map(getPick).filter(Boolean).map(pickInfo);
}
const sourcesOf = s => ({ channels: channelInfo(s.channels), playlists: playlistInfo(s.playlists), picks: picksInfo(s.videos) });

app.get('/api/me', auth, (req, res) => {
  const p = req.parent;
  const settings = readSettings(p);
  res.json({
    parent: { email: p.email, name: p.name, picture: p.picture },
    hasPin: !!p.pin_hash,
    canResetPin: now() - p.session_created < FRESH_LOGIN_MS,
    settings,
    ...sourcesOf(settings),
    usage: usageFor(p, dayOf(req))
  });
});

app.post('/api/pin', auth, (req, res) => {
  const { pin, currentPin } = req.body || {};
  if (!validPin(pin)) return fail(res, 400, 'PIN must be 4 digits');
  const p = req.parent;
  const ut = req.get('x-parent-token');
  const unlocked = ut && unlocks.get(ut)?.parentId === p.id && unlocks.get(ut).exp > now();
  const allowed = !p.pin_hash || unlocked || (currentPin && checkPin(currentPin, p.pin_hash))
    || now() - p.session_created < FRESH_LOGIN_MS;
  if (!allowed) return fail(res, 403, 'Enter your current PIN — or sign out and sign in again with Google to reset it');
  db.prepare('UPDATE parents SET pin_hash = ? WHERE id = ?').run(hashPin(pin), p.id);
  const t = crypto.randomBytes(24).toString('base64url');
  unlocks.set(t, { parentId: p.id, exp: now() + UNLOCK_MS });
  res.json({ ok: true, parentToken: t });
});

app.post('/api/pin/verify', auth, (req, res) => {
  const p = req.parent;
  if (!rateLimit('pin:' + p.id, 6, 5 * 60000)) return fail(res, 429, 'Too many tries — wait 5 minutes');
  if (!checkPin(req.body?.pin, p.pin_hash)) return fail(res, 403, 'Wrong PIN');
  const t = crypto.randomBytes(24).toString('base64url');
  unlocks.set(t, { parentId: p.id, exp: now() + UNLOCK_MS });
  res.json({ ok: true, parentToken: t });
});

app.put('/api/settings', auth, requireUnlock, (req, res) => {
  const b = req.body || {};
  const cur = readSettings(req.parent);
  const next = { ...cur };
  if (Array.isArray(b.channels)) {
    const ids = [...new Set(b.channels.filter(id => /^UC[\w-]{22}$/.test(id)))].slice(0, 50);
    next.channels = ids.filter(id => getChannel(id));          // only channels resolved through /api/channels
  }
  if (Array.isArray(b.playlists)) {
    const ids = [...new Set(b.playlists.filter(id => /^[\w-]{10,64}$/.test(id)))].slice(0, 20);
    next.playlists = ids.filter(id => getPlaylist(id));        // only playlists resolved through /api/picks/playlist
  }
  if (Array.isArray(b.videos)) {
    const ids = [...new Set(b.videos.filter(id => /^[\w-]{11}$/.test(id)))].slice(0, 200);
    next.videos = ids.filter(id => getPick(id));               // only videos resolved through /api/picks/video
  }
  if (Array.isArray(b.blockWords)) {
    next.blockWords = b.blockWords.map(w => String(w).trim().slice(0, 40)).filter(Boolean).slice(0, 50);
  }
  if (typeof b.hideShorts === 'boolean') next.hideShorts = b.hideShorts;
  if (b.dailyLimit !== undefined) next.dailyLimit = Math.min(600, Math.max(0, parseInt(b.dailyLimit) || 0));
  if (b.perChannel !== undefined) next.perChannel = Math.min(50, Math.max(5, parseInt(b.perChannel) || 25));
  db.prepare('UPDATE parents SET settings = ? WHERE id = ?').run(JSON.stringify(next), req.parent.id);
  res.json({ ok: true, settings: next, ...sourcesOf(next) });
});

// Look-ups used by Parent settings → "Add". Each costs at most 1 YouTube quota unit.
const lookup = (resolve, shape) => wrap(async (req, res) => {
  if (!rateLimit('resolve:' + req.parent.id, 30, 10 * 60000)) return fail(res, 429, 'Too many lookups — try again later');
  try {
    res.json(shape(await resolve(req.body?.input)));
  } catch (e) {
    fail(res, e.status && e.status < 500 ? e.status : 502, e.message);
  }
});
app.post('/api/channels', auth, requireUnlock, lookup(resolveChannel, c => ({ id: c.id, title: c.title, thumb: c.thumb })));
app.post('/api/picks/playlist', auth, requireUnlock,
  lookup(resolvePlaylist, p => ({ id: p.id, title: p.title, thumb: p.thumb, channel: p.channel })));
app.post('/api/picks/video', auth, requireUnlock, lookup(resolveVideo, pickInfo));

app.delete('/api/account', auth, requireUnlock, (req, res) => {
  db.prepare('DELETE FROM parents WHERE id = ?').run(req.parent.id);   // cascades sessions + usage
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

/* ---------------- videos ---------------- */
// Every video carries `src`: the chips it belongs to ('picks', a playlist id, and/or a channel id).
app.get('/api/videos', auth, wrap(async (req, res) => {
  const s = readSettings(req.parent);
  const sources = [
    ...s.playlists.map(id => ({ id, load: playlistVideos(id), limit: Infinity })),
    ...s.channels.map(id => ({ id, load: channelVideos(id), limit: s.perChannel }))
  ];
  const [picksR, ...results] = await Promise.allSettled([pickVideos(s.videos), ...sources.map(x => x.load)]);
  const words = s.blockWords.map(w => w.toLowerCase());
  const allowed = v => {
    if (s.hideShorts && v.secs <= 180) return false;
    if (!words.length) return true;
    const text = [v.title, v.desc || '', ...(v.tags || [])].join(' \n ').toLowerCase();
    return !words.some(w => text.includes(w));
  };

  const byId = new Map();
  const add = (v, src) => {
    const have = byId.get(v.id);
    if (have) { if (!have.src.includes(src)) have.src.push(src); return; }
    const { desc, tags, ...pub } = v;     // keep description/tags on the server
    byId.set(v.id, { ...pub, src: [src] });
  };

  // 1. Single videos the parent added: newest first, never filtered (the parent chose each one).
  const picks = picksR.status === 'fulfilled' ? picksR.value.slice().reverse() : [];
  for (const v of picks) add(v, 'picks');

  // 2. Playlists (up to 100 each) and channels (latest perChannel): filters first, then the limit.
  let failed = picksR.status === 'fulfilled' ? 0 : 1;
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') { failed++; return; }
    let kept = 0;
    for (const v of r.value) {
      if (kept >= sources[i].limit) break;
      if (!allowed(v)) continue;
      add(v, sources[i].id);
      kept++;
    }
  });

  const pickIds = new Set(picks.map(v => v.id));
  const rest = [...byId.values()].filter(v => !pickIds.has(v.id))
    .sort((a, b) => b.published.localeCompare(a.published));
  const videos = [...picks.map(v => byId.get(v.id)), ...rest];
  res.json({ videos, failedChannels: failed, usage: usageFor(req.parent, dayOf(req)) });
}));

/* ---------------- screen time ---------------- */
app.post('/api/usage/tick', auth, (req, res) => {
  const secs = Math.min(120, Math.max(0, parseInt(req.body?.seconds) || 0));
  const day = dayOf(req);
  db.prepare(`INSERT INTO usage (parent_id, day, seconds) VALUES (?, ?, ?)
    ON CONFLICT(parent_id, day) DO UPDATE SET seconds = seconds + excluded.seconds`).run(req.parent.id, day, secs);
  const v = req.body?.video;
  if (secs && v && /^[\w-]{11}$/.test(v.id)) {
    const str = (x, n) => String(x ?? '').slice(0, n);
    const thumb = /^https:\/\/i\d?\.ytimg\.com\//.test(v.thumb || '') ? str(v.thumb, 300) : '';
    db.prepare(`INSERT INTO history (parent_id, day, video_id, title, channel, thumb, seconds, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(parent_id, day, video_id) DO UPDATE SET seconds = seconds + excluded.seconds, last_at = excluded.last_at,
        title = excluded.title, channel = excluded.channel, thumb = excluded.thumb`)
      .run(req.parent.id, day, v.id, str(v.title, 200), str(v.channel, 100), thumb, secs, now());
  }
  res.json({ usage: usageFor(req.parent, day) });
});

/* ---------------- watch history (last 7 days) ---------------- */
app.get('/api/history', auth, requireUnlock, (req, res) => {
  const from = new Date(Date.parse(dayOf(req) + 'T00:00:00Z') - (HISTORY_DAYS - 1) * 86400000).toISOString().slice(0, 10);
  const rows = db.prepare(`SELECT day, video_id AS id, title, channel, thumb, seconds FROM history
    WHERE parent_id = ? AND day >= ? ORDER BY day DESC, last_at DESC`).all(req.parent.id, from);
  const days = [];
  for (const r of rows) {
    let d = days[days.length - 1];
    if (!d || d.day !== r.day) days.push(d = { day: r.day, seconds: 0, videos: [] });
    d.seconds += r.seconds;
    const { day, ...video } = r;
    d.videos.push(video);
  }
  res.json({ days });
});

app.delete('/api/history', auth, requireUnlock, (req, res) => {
  db.prepare('DELETE FROM history WHERE parent_id = ?').run(req.parent.id);
  res.json({ ok: true });
});

app.post('/api/usage/bonus', auth, requireUnlock, (req, res) => {
  const mins = Math.min(240, Math.max(0, parseInt(req.body?.minutes) || 0));
  const day = dayOf(req);
  db.prepare(`INSERT INTO usage (parent_id, day, bonus) VALUES (?, ?, ?)
    ON CONFLICT(parent_id, day) DO UPDATE SET bonus = bonus + excluded.bonus`).run(req.parent.id, day, mins * 60);
  res.json({ usage: usageFor(req.parent, day) });
});

app.post('/api/usage/reset', auth, requireUnlock, (req, res) => {
  const day = dayOf(req);
  db.prepare('DELETE FROM usage WHERE parent_id = ? AND day = ?').run(req.parent.id, day);
  res.json({ usage: usageFor(req.parent, day) });
});

/* ---------------- errors ---------------- */
app.use('/api', (req, res) => fail(res, 404, 'Not found'));
app.use((err, req, res, next) => {
  console.error(err);
  fail(res, 500, 'Server error');
});

app.listen(PORT, HOST, () => console.log(`Kids Tube listening on http://${HOST}:${PORT}`));
