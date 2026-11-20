import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/*
 * X (Twitter): public posts only, no login and no API key. A post is read from X's
 * syndication API (cdn.syndication.twimg.com/tweet-result), the one embedded posts on other
 * websites use. It returns the post as JSON with every photo (pbs.twimg.com) and every MP4
 * rendition of each video or GIF (video.twimg.com, audio included), so nothing needs yt-dlp.
 *
 * Key (see KEY_TYPES in instagram.js): x-<post id>.
 *
 * Not available logged out: protected accounts, deleted posts (empty answer or 404) and
 * posts X marks as sensitive (a "TweetTombstone" instead of the post).
 */

// x.com, twitter.com and their mirrors. The lookbehind stops "box.com" or "netflix.com" matching.
const X_URL =
  /(?<![\w.-])(?:https?:\/\/)?(?:(?:www|mobile|m)\.)?(?:x|twitter|fxtwitter|vxtwitter|fixupx|fixvx)\.com\/[^\s<>"']*/i;
const TCO_URL = /(?<![\w.-])(?:https?:\/\/)?t\.co\/([A-Za-z0-9]{1,20})(?![\w])/i;
const POST_ID = /^\d{1,25}$/;
const USERNAME = /^\w{1,30}$/;

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT_MS = 20_000;
const VIDEO_LIMIT = 49 * 1024 * 1024; // Telegram's 50 MB upload limit for bots, with some room
const FILE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4' };

const xError = (message, extra) => Object.assign(new Error(message), { source: 'x', ...extra });

// ---------- the post ----------

// The syndication API wants a token derived from the id (the same formula X's embed code uses).
const tokenFor = (id) => ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');

async function fetchPost(id) {
  const url = `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${tokenFor(id)}&lang=en`;
  const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 404) throw xError(`X post ${id} not found`, { code: 'X_GONE' });
  if (res.status === 429) throw xError('X is rate-limiting requests', { code: 'X_RATE_LIMIT' });
  if (!res.ok) throw xError(`HTTP ${res.status} for X post ${id}`);
  const text = await res.text();
  if (!text.trim()) throw xError(`X post ${id} is empty (deleted or protected)`, { code: 'X_GONE' });
  const post = JSON.parse(text);
  if (post?.__typename === 'TweetTombstone') throw xError(`X post ${id} is hidden`, { code: 'X_HIDDEN' });
  return post;
}

/** The MP4 renditions of a video or GIF, best first. */
const mp4s = (media) =>
  (media?.video_info?.variants ?? [])
    .filter((variant) => variant?.content_type === 'video/mp4' && variant.url)
    .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))
    .map((variant) => variant.url);

/** A post's media as items: { kind, urls (best first), width, height, duration }. */
function postItems(post) {
  return (post?.mediaDetails ?? []).flatMap((media) => {
    const width = media?.original_info?.width;
    const height = media?.original_info?.height;
    if (media?.type === 'photo' && media.media_url_https) {
      const url = new URL(media.media_url_https);
      url.searchParams.set('name', 'orig'); // full size
      return [{ kind: 'photo', urls: [url.href], width, height }];
    }
    if (media?.type === 'video' || media?.type === 'animated_gif') {
      const urls = mp4s(media);
      const duration = media.video_info?.duration_millis ? media.video_info.duration_millis / 1000 : undefined;
      return urls.length ? [{ kind: 'video', urls, width, height, duration }] : [];
    }
    return [];
  });
}

/** Reads a post. Returns { username, name, items }; a post without media of its own uses its quoted post's. */
async function readPost(id) {
  const post = await fetchPost(id);
  let source = post;
  let items = postItems(post);
  if (items.length === 0 && post.quoted_tweet) {
    source = post.quoted_tweet;
    items = postItems(source);
  }
  if (items.length === 0) throw xError(`X post ${id} has no photos or videos`, { code: 'NO_MEDIA' });
  return { username: source.user?.screen_name ?? null, name: source.user?.name ?? null, items };
}

// ---------- files ----------

const allowedHost = (url) => url.protocol === 'https:' && ['pbs.twimg.com', 'video.twimg.com'].includes(url.hostname);

/** The first URL whose file fits Telegram's limit (videos come in several sizes), else the smallest. */
async function pickUrl(item) {
  if (item.kind !== 'video' || item.urls.length === 1) return item.urls[0];
  for (const url of item.urls) {
    const res = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(
      () => null,
    );
    const size = Number(res?.headers.get('content-length'));
    if (res?.ok && size && size <= VIDEO_LIMIT) return url;
  }
  return item.urls.at(-1);
}

/** Downloads a photo or video from X's CDN to `<base>.<ext>`. Returns the path. */
async function downloadFile(fileUrl, base) {
  const url = new URL(fileUrl);
  if (!allowedHost(url)) throw xError(`Not an X media URL: ${url.hostname}`);
  const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(5 * 60_000) });
  const ext = FILE_EXT[res.headers.get('content-type')?.split(';')[0].trim()];
  if (!res.ok || !ext) throw xError(`HTTP ${res.status} (${res.headers.get('content-type')}) for an X file`);
  const file = `${base}.${ext}`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
  return file;
}

/**
 * Downloads every photo and video of the X post a key points at into `dir`, in order. A
 * failed item makes the result partial. Returns the same shape as downloadMedia.
 */
export async function downloadXPost(key, request, dir) {
  const post = await readPost(request.xId);
  const items = [];
  let partial = false;
  for (const [i, item] of post.items.entries()) {
    try {
      const file = await downloadFile(await pickUrl(item), path.join(dir, `${String(i + 1).padStart(2, '0')}-${item.kind}`));
      items.push({ file, kind: file.endsWith('.mp4') ? 'video' : 'photo', width: item.width, height: item.height, duration: item.duration });
    } catch (err) {
      console.warn(`[${key}] item ${i + 1} failed:`, err.message);
      partial = true;
    }
  }
  if (items.length === 0) throw xError(`Nothing in ${key} could be downloaded`);
  return { author: post.name, username: USERNAME.test(post.username ?? '') ? post.username : null, partial, items };
}

// ---------- links ----------

const UNSUPPORTED = { unsupported: true, site: 'x' };

/**
 * Finds the first x.com / twitter.com link (or t.co short link) in `text`. Returns null,
 * { key: 'x-<id>' }, { share, site: 'x' } for t.co links (pass to resolveXShareLink), or
 * { unsupported: true, site: 'x' } for profiles and other pages.
 */
export function parseXLink(text) {
  const tco = text.match(TCO_URL);
  const match = text.match(X_URL);
  if (tco && (!match || tco.index < match.index)) return { share: `https://t.co/${tco[1]}`, site: 'x' };
  if (!match) return null;
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(match[0]) ? match[0] : `https://${match[0]}`);
  } catch {
    return null;
  }
  // /<user>/status/<id>[/photo/1], /i/status/<id>, /i/web/status/<id>, /<user>/statuses/<id>
  const parts = url.pathname.split('/').filter(Boolean);
  const at = parts.findIndex((part) => part === 'status' || part === 'statuses');
  const id = at >= 0 ? parts[at + 1] : null;
  return id && POST_ID.test(id) ? { key: `x-${id}` } : UNSUPPORTED;
}

/** Follows a t.co link's redirects (at most 3) to an X post. Returns its key, or null. */
export async function resolveXShareLink(url) {
  let current = url;
  for (let hop = 0; hop < 3; hop++) {
    const res = await fetch(current, { headers: { 'User-Agent': 'curl/8' }, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    const location = res.headers.get('location');
    if (!location || res.status < 300 || res.status >= 400) return null;
    const next = new URL(location, current).href;
    const link = parseXLink(next);
    if (link?.key) return link.key;
    if (!link?.share || link.share === current) return null;
    current = link.share;
  }
  return null;
}
