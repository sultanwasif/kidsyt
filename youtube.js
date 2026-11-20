import { db } from './db.js';

const BASE = process.env.YT_API_BASE || 'https://www.googleapis.com/youtube/v3';
const CACHE_MS = (parseInt(process.env.CACHE_MINUTES) || 60) * 60 * 1000;

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

function isoSecs(d) {
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d || '') || [];
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

export function parseChannelInput(s) {
  s = String(s || '').trim();
  let m = s.match(/(UC[\w-]{22})/);
  if (m) return { id: m[1] };
  m = s.match(/@([\w.\-]{3,100})/);
  if (m) return { forHandle: '@' + m[1] };
  if (/^[\w.\-]{3,100}$/.test(s)) return { forHandle: '@' + s };
  return null;
}

const getChannelStmt = db.prepare('SELECT * FROM channels WHERE id = ?');
const upsertChannel = db.prepare(`INSERT INTO channels (id, title, thumb, uploads) VALUES (@id, @title, @thumb, @uploads)
  ON CONFLICT(id) DO UPDATE SET title = excluded.title, thumb = excluded.thumb, uploads = excluded.uploads`);
const saveVideos = db.prepare('UPDATE channels SET videos = ?, fetched_at = ? WHERE id = ?');

export const getChannel = id => getChannelStmt.get(id);

/** Look up a channel by @handle, link or UC… id. Costs 1 quota unit (0 if already known by id). */
export async function resolveChannel(input) {
  const q = parseChannelInput(input);
  if (!q) throw Object.assign(new Error('Paste a channel link, @handle or channel ID'), { status: 400 });
  if (q.id) {
    const known = getChannel(q.id);
    if (known) return known;
  }
  const j = await yt('channels', { part: 'snippet,contentDetails', ...q });
  const c = j.items?.[0];
  if (!c) throw Object.assign(new Error('Channel not found — check the handle'), { status: 404 });
  upsertChannel.run({
    id: c.id,
    title: c.snippet.title,
    thumb: c.snippet.thumbnails?.default?.url || '',
    uploads: c.contentDetails.relatedPlaylists.uploads
  });
  return getChannel(c.id);
}

/** Latest (up to 50) videos for a channel, shared across all families and refreshed at most every CACHE_MINUTES. */
const inflight = new Map();
export function channelVideos(id) {
  const row = getChannel(id);
  if (!row) return Promise.resolve([]);
  if (row.videos && Date.now() - row.fetched_at < CACHE_MS) {
    const cached = JSON.parse(row.videos);
    // lists saved before tags/description were stored get refreshed once
    if (!cached.length || cached[0].tags !== undefined) return Promise.resolve(cached);
  }
  if (inflight.has(id)) return inflight.get(id);
  const p = refresh(row).finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

async function refresh(row) {
  try {
    let ids = [];
    try {
      const pl = await yt('playlistItems', { part: 'contentDetails', playlistId: row.uploads, maxResults: 50 });
      ids = (pl.items || []).map(it => it.contentDetails.videoId);
    } catch (e) {
      if (e.status !== 404) throw e;           // 404 = channel has no uploads
    }
    const videos = [];
    if (ids.length) {
      const j = await yt('videos', { part: 'snippet,contentDetails,status', id: ids.join(',') });
      for (const v of j.items || []) {
        if (!['public', 'unlisted'].includes(v.status?.privacyStatus)) continue;
        if (v.status?.embeddable === false) continue;
        if (v.snippet.liveBroadcastContent !== 'none') continue;   // skip live & upcoming
        const t = v.snippet.thumbnails || {};
        videos.push({
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
        });
      }
      videos.sort((a, b) => b.published.localeCompare(a.published));
    }
    saveVideos.run(JSON.stringify(videos), Date.now(), row.id);
    return videos;
  } catch (e) {
    console.error(`[youtube] refresh ${row.id} failed:`, e.message);
    if (row.videos) return JSON.parse(row.videos);           // serve stale rather than nothing
    throw e;
  }
}
