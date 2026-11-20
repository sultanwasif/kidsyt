import { db } from './db.js';

const BASE = process.env.YT_API_BASE || 'https://www.googleapis.com/youtube/v3';
const CACHE_MS = (parseInt(process.env.CACHE_MINUTES) || 60) * 60 * 1000;
const PICK_CACHE_MS = 24 * 3600 * 1000;      // single videos: re-check once a day (still public/embeddable?)
const PLAYLIST_PAGES = 2;                      // playlists: up to 100 videos

async function yt(endpoint, params) {
  const u = new URL(BASE + '/' + endpoint);
  for (const [k, v] of Object.entries({ ...params, key: process.env.YT_API_KEY })) u.searchParams.set(k, v);
  const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(j.error?.message || 'YouTube HTTP ' + r.status);
    err.status = r.status;
    throw err;
  }
  return j;
}
const userError = (status, msg) => Object.assign(new Error(msg), { status });

function isoSecs(d) {
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d || '') || [];
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

/** YouTube API video → our video object, or null if it can't be played in the app. */
function toVideo(v) {
  if (!['public', 'unlisted'].includes(v.status?.privacyStatus)) return null;
  if (v.status?.embeddable === false) return null;
  if (v.snippet.liveBroadcastContent !== 'none') return null;   // skip live & upcoming
  const t = v.snippet.thumbnails || {};
  return {
    id: v.id,
    title: v.snippet.title,
    channelId: v.snippet.channelId,
    channel: v.snippet.channelTitle,
    published: v.snippet.publishedAt,
    secs: isoSecs(v.contentDetails.duration),
    thumb: (t.high || t.medium || t.default || {}).url || '',
    // used only for blocked-word filtering on the server (never sent to the browser)
    desc: (v.snippet.description || '').slice(0, 1500),
    tags: (v.snippet.tags || []).slice(0, 40)
  };
}

/** Details for many video ids (50 per call, 1 quota unit each), in the same order, unplayable ones dropped. */
async function videoDetails(ids) {
  const found = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const j = await yt('videos', { part: 'snippet,contentDetails,status', id: ids.slice(i, i + 50).join(',') });
    for (const item of j.items || []) {
      const v = toVideo(item);
      if (v) found.set(v.id, v);
    }
  }
  return ids.map(id => found.get(id)).filter(Boolean);
}

/** Videos of a playlist (an uploads list or a normal playlist), up to `pages` × 50. */
async function listVideos(playlistId, pages) {
  const ids = [];
  let pageToken;
  for (let i = 0; i < pages; i++) {
    let pl;
    try {
      pl = await yt('playlistItems', { part: 'contentDetails', playlistId, maxResults: 50, ...(pageToken && { pageToken }) });
    } catch (e) {
      if (e.status === 404) break;             // empty / removed playlist
      throw e;
    }
    ids.push(...(pl.items || []).map(it => it.contentDetails.videoId));
    pageToken = pl.nextPageToken;
    if (!pageToken) break;
  }
  return videoDetails([...new Set(ids)]);
}

/* ---------------- input parsing ---------------- */
export function parseChannelInput(s) {
  s = String(s || '').trim();
  let m = s.match(/(UC[\w-]{22})/);
  if (m) return { id: m[1] };
  m = s.match(/@([\w.\-]{3,100})/);
  if (m) return { forHandle: '@' + m[1] };
  if (/^[\w.\-]{3,100}$/.test(s)) return { forHandle: '@' + s };
  return null;
}
export function parseVideoInput(s) {
  s = String(s || '').trim();
  const m = s.match(/(?:[?&]v=|youtu\.be\/|\/shorts\/|\/embed\/|\/live\/|\/v\/)([\w-]{11})(?![\w-])/);
  if (m) return m[1];
  if (/^[\w-]{11}$/.test(s)) return s;
  return null;
}
export function parsePlaylistInput(s) {
  s = String(s || '').trim();
  const m = s.match(/[?&]list=([\w-]{10,64})/);
  if (m) return m[1];
  if (/^(PL|UU|FL|OL)[\w-]{10,62}$/.test(s)) return s;
  return null;
}

/* ---------------- shared cache helper ---------------- */
const inflight = new Map();
function cachedList(key, row, load, save) {
  if (row.videos && Date.now() - row.fetched_at < CACHE_MS) {
    const cached = JSON.parse(row.videos);
    // lists saved before tags/description were stored get refreshed once
    if (!cached.length || cached[0].tags !== undefined) return Promise.resolve(cached);
  }
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const videos = await load();
      save.run(JSON.stringify(videos), Date.now(), row.id);
      return videos;
    } catch (e) {
      console.error(`[youtube] refresh ${key} failed:`, e.message);
      if (row.videos) return JSON.parse(row.videos);       // serve stale rather than nothing
      throw e;
    }
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/* ---------------- channels ---------------- */
const getChannelStmt = db.prepare('SELECT * FROM channels WHERE id = ?');
const upsertChannel = db.prepare(`INSERT INTO channels (id, title, thumb, uploads) VALUES (@id, @title, @thumb, @uploads)
  ON CONFLICT(id) DO UPDATE SET title = excluded.title, thumb = excluded.thumb, uploads = excluded.uploads`);
const saveChannelVideos = db.prepare('UPDATE channels SET videos = ?, fetched_at = ? WHERE id = ?');

export const getChannel = id => getChannelStmt.get(id);

/** Look up a channel by @handle, link or UC… id. Costs 1 quota unit (0 if already known by id). */
export async function resolveChannel(input) {
  const q = parseChannelInput(input);
  if (!q) throw userError(400, 'Paste a channel link, @handle or channel ID');
  if (q.id) {
    const known = getChannel(q.id);
    if (known) return known;
  }
  const j = await yt('channels', { part: 'snippet,contentDetails', ...q });
  const c = j.items?.[0];
  if (!c) throw userError(404, 'Channel not found — check the handle');
  upsertChannel.run({
    id: c.id,
    title: c.snippet.title,
    thumb: c.snippet.thumbnails?.default?.url || '',
    uploads: c.contentDetails.relatedPlaylists.uploads
  });
  return getChannel(c.id);
}

/** Latest (up to 50) videos for a channel, shared across all families and refreshed at most every CACHE_MINUTES. */
export function channelVideos(id) {
  const row = getChannel(id);
  if (!row) return Promise.resolve([]);
  return cachedList('ch:' + id, row, async () => {
    const videos = await listVideos(row.uploads, 1);
    return videos.sort((a, b) => b.published.localeCompare(a.published));
  }, saveChannelVideos);
}

/* ---------------- playlists ---------------- */
const getPlaylistStmt = db.prepare('SELECT * FROM playlists WHERE id = ?');
const upsertPlaylist = db.prepare(`INSERT INTO playlists (id, title, thumb, channel) VALUES (@id, @title, @thumb, @channel)
  ON CONFLICT(id) DO UPDATE SET title = excluded.title, thumb = excluded.thumb, channel = excluded.channel`);
const savePlaylistVideos = db.prepare('UPDATE playlists SET videos = ?, fetched_at = ? WHERE id = ?');

export const getPlaylist = id => getPlaylistStmt.get(id);

/** Look up a public/unlisted playlist by link or id. Costs 1 quota unit (0 if already known). */
export async function resolvePlaylist(input) {
  const id = parsePlaylistInput(input);
  if (!id) throw userError(400, 'Paste a playlist link (it contains "list=")');
  const known = getPlaylist(id);
  if (known) return known;
  const j = await yt('playlists', { part: 'snippet', id });
  const p = j.items?.[0];
  if (!p) throw userError(404, 'Playlist not found — it must be Public or Unlisted');
  const t = p.snippet.thumbnails || {};
  upsertPlaylist.run({
    id: p.id,
    title: p.snippet.title,
    thumb: (t.medium || t.default || {}).url || '',
    channel: p.snippet.channelTitle || ''
  });
  return getPlaylist(p.id);
}

/** Up to 100 videos of a playlist in playlist order, shared and refreshed at most every CACHE_MINUTES. */
export function playlistVideos(id) {
  const row = getPlaylist(id);
  if (!row) return Promise.resolve([]);
  return cachedList('pl:' + id, row, () => listVideos(id, PLAYLIST_PAGES), savePlaylistVideos);
}

/* ---------------- single videos ("picks") ---------------- */
const getPickStmt = db.prepare('SELECT * FROM picks WHERE id = ?');
const upsertPick = db.prepare(`INSERT INTO picks (id, data, fetched_at) VALUES (?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`);
const deletePick = db.prepare('DELETE FROM picks WHERE id = ?');

export function getPick(id) {
  const row = getPickStmt.get(id);
  return row ? JSON.parse(row.data) : null;
}

/** Look up one video by link or id. Costs 1 quota unit (0 if already known). */
export async function resolveVideo(input) {
  const id = parseVideoInput(input);
  if (!id) throw userError(400, 'Paste a YouTube video link');
  const known = getPick(id);
  if (known) return known;
  const [v] = await videoDetails([id]);
  if (!v) throw userError(404, "Video not found, private, live, or it can't be played outside YouTube");
  upsertPick.run(v.id, JSON.stringify(v), Date.now());
  return v;
}

/** Saved single videos; re-checks ones older than a day and drops any that became private/removed. */
let pickRefresh = null;
export async function pickVideos(ids) {
  const stale = ids.filter(id => {
    const row = getPickStmt.get(id);
    return row && Date.now() - row.fetched_at > PICK_CACHE_MS;
  });
  if (stale.length) {
    pickRefresh ||= (async () => {
      try {
        const fresh = await videoDetails(stale);
        const ok = new Set(fresh.map(v => v.id));
        for (const v of fresh) upsertPick.run(v.id, JSON.stringify(v), Date.now());
        for (const id of stale) if (!ok.has(id)) deletePick.run(id);
      } catch (e) {
        console.error('[youtube] refresh picks failed:', e.message);   // keep serving the saved data
      }
    })().finally(() => { pickRefresh = null; });
    await pickRefresh;
  }
  return ids.map(getPick).filter(Boolean);
}
