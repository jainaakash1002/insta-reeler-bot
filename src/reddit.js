import fs from 'node:fs/promises';
import https from 'node:https';

/*
 * Reddit links. A post link becomes the key r-<post id> (see KEY_TYPES in instagram.js);
 * requestFor rebuilds the post URL from that id, so text from the message never reaches a
 * request or yt-dlp.
 *
 * Reddit blocks anonymous requests for post data from many networks (HTTP 403), so the post
 * is read through Reddit's official API when REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET are
 * set (a free "script" app from reddit.com/prefs/apps, application-only OAuth: no Reddit
 * account login). Without them the public .json endpoint is tried.
 *
 * What a post holds:
 *   gallery   gallery_data.items (order) + media_metadata (each image, or an animated one as MP4)
 *   video     secure_media.reddit_video: a DASH manifest on v.redd.it (video and audio are
 *             separate files, yt-dlp merges them)
 *   image     url on i.redd.it, or a preview image for images hosted elsewhere
 *   GIF       the preview's MP4 variant, or preview.reddit_video_preview
 * Crossposts use the original post (crosspost_parent_list[0]). Text posts and links to other
 * sites (YouTube, …) have nothing to download.
 */

// The first Reddit link in a message: reddit.com (www, old, new, m, np, sh, …), redd.it and v.redd.it.
const REDDIT_URL = /(?<![\w.-])(?:https?:\/\/)?(?:[\w-]+\.)*(?:reddit\.com|redd\.it)\/[^\s<>"']*/i;
const POST_ID = /^[a-z0-9]{1,12}$/i; // base36
const CODE = /^[\w-]{1,40}$/; // share-link and v.redd.it codes
const MEDIA_ID = /^[A-Za-z0-9]{1,40}$/;

const USER_AGENT = 'node:insta-reel-bot:v1.0 (personal Telegram bot)'; // Reddit asks for a descriptive one
const REQUEST_TIMEOUT_MS = 15_000;

const redditError = (message, extra) => Object.assign(new Error(message), { source: 'reddit', ...extra });

// ---------- API access ----------

let token = null; // { value, expires }

const hasKey = () => Boolean(process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET);

/** An application-only OAuth token (valid for a day), cached until a minute before it expires. */
async function accessToken() {
  if (token && token.expires > Date.now()) return token.value;
  const auth = Buffer.from(`${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    // 401: wrong id or secret. The message never includes them.
    throw redditError(`Reddit refused the API key (HTTP ${res.status})`, { code: 'REDDIT_KEY_INVALID' });
  }
  token = { value: body.access_token, expires: Date.now() + ((body.expires_in ?? 3600) - 60) * 1000 };
  return token.value;
}

/** GET a Reddit JSON endpoint: through the API with the key, else the public .json URL. */
async function getJson(apiPath) {
  const keyed = hasKey();
  const url = keyed ? `https://oauth.reddit.com${apiPath}` : `https://www.reddit.com${apiPath}.json`;
  const headers = { 'User-Agent': USER_AGENT };
  if (keyed) headers.Authorization = `Bearer ${await accessToken()}`;
  const res = await fetch(`${url}?raw_json=1`, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (res.status === 401 && keyed) token = null; // expired early: the next request gets a new one
  if (!res.ok) {
    const blocked = !keyed && (res.status === 403 || res.status === 429);
    throw redditError(`HTTP ${res.status} from Reddit for ${apiPath}`, {
      code: blocked ? 'REDDIT_NEEDS_KEY' : res.status === 404 ? 'NO_MEDIA' : undefined,
      status: res.status,
    });
  }
  return res.json();
}

// ---------- reading a post ----------

const httpsUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
};

const MIME_EXT = { 'image/jpg': 'jpg', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** A DASH manifest URL on v.redd.it for a reddit_video object, or null. */
function dashUrl(video) {
  const url = httpsUrl(video?.dash_url);
  if (url?.hostname === 'v.redd.it') return url.href;
  const id = httpsUrl(video?.fallback_url)?.hostname === 'v.redd.it' && new URL(video.fallback_url).pathname.split('/')[1];
  return id && MEDIA_ID.test(id) ? `https://v.redd.it/${id}/DASHPlaylist.mpd` : null;
}

/** The items of a post's media, in order: { kind: 'photo' | 'video' | 'mp4', url, id, width, height }. */
function postItems(post) {
  const postId = MEDIA_ID.test(post.id ?? '') ? post.id : 'item'; // used in file names
  // A gallery: each item's full-size image on i.redd.it, or the MP4 of an animated one.
  if (post.gallery_data?.items?.length && post.media_metadata) {
    return post.gallery_data.items.flatMap(({ media_id: id }) => {
      const meta = post.media_metadata[id];
      if (!MEDIA_ID.test(id ?? '') || meta?.status !== 'valid') return [];
      const size = { width: meta.s?.x, height: meta.s?.y };
      if (meta.e === 'AnimatedImage') return meta.s?.mp4 ? [{ kind: 'mp4', url: meta.s.mp4, id, ...size }] : [];
      const ext = MIME_EXT[meta.m];
      const url = ext ? `https://i.redd.it/${id}.${ext}` : meta.s?.u;
      return url ? [{ kind: 'photo', url, fallback: meta.s?.u, id, ...size }] : [];
    });
  }

  const video = post.secure_media?.reddit_video ?? post.media?.reddit_video;
  const manifest = dashUrl(video);
  if (manifest) return [{ kind: 'video', url: manifest, id: postId, width: video.width, height: video.height }];

  const preview = post.preview?.images?.[0];
  const mp4 = preview?.variants?.mp4?.source;
  const destination = httpsUrl(post.url_overridden_by_dest ?? post.url);
  // A GIF: send its MP4 version, which Telegram plays as a video
  if (mp4?.url && (post.post_hint === 'image' || /\.gif$/i.test(destination?.pathname ?? ''))) {
    return [{ kind: 'mp4', url: mp4.url, id: postId, width: mp4.width, height: mp4.height }];
  }
  // A video hosted elsewhere (e.g. a gifv) that Reddit converted for its player
  const converted = dashUrl(post.preview?.reddit_video_preview);
  if (converted) return [{ kind: 'video', url: converted, id: postId }];
  if (post.post_hint === 'image' || destination?.hostname === 'i.redd.it') {
    const source = preview?.source;
    const url = destination?.hostname === 'i.redd.it' ? destination.href : source?.url;
    if (url) return [{ kind: 'photo', url, fallback: source?.url, id: postId, width: source?.width, height: source?.height }];
  }
  return [];
}

/**
 * Reads a post. Returns { author, subreddit, items, external }, where `external` is the
 * domain of a link post with nothing hosted on Reddit (e.g. "youtube.com").
 */
export async function readRedditPost(postId) {
  const listing = await getJson(`/comments/${postId}`);
  let post = listing?.[0]?.data?.children?.[0]?.data;
  if (!post) throw redditError(`No post in Reddit's answer for ${postId}`, { code: 'NO_MEDIA' });
  const author = post.author && post.author !== '[deleted]' ? post.author : null;
  const subreddit = post.subreddit_name_prefixed ?? null;
  if (post.crosspost_parent_list?.[0]) post = post.crosspost_parent_list[0];
  const items = postItems(post);
  const external = items.length === 0 && !post.is_self ? (post.domain ?? null) : null;
  return { author, subreddit, items, external };
}

// ---------- downloading files ----------

const FILE_LIMIT = 60 * 1024 * 1024;
const FILE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4' };
const MEDIA_HOSTS = new Set(['i.redd.it', 'preview.redd.it', 'external-preview.redd.it', 'v.redd.it']);

/** Downloads an image or MP4 from Reddit's media servers to `<base>.<ext>`. Returns the file path. */
export function downloadRedditFile(fileUrl, base) {
  const url = httpsUrl(fileUrl);
  if (!url || !MEDIA_HOSTS.has(url.hostname)) {
    return Promise.reject(redditError(`Not a Reddit media URL: ${url?.hostname ?? fileUrl}`));
  }
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': USER_AGENT }, timeout: 60_000 }, (res) => {
      const ext = FILE_EXT[res.headers['content-type']?.split(';')[0].trim()];
      if (res.statusCode !== 200 || !ext) {
        res.resume();
        return reject(redditError(`HTTP ${res.statusCode} (${res.headers['content-type']}) for ${url.hostname}`));
      }
      let size = 0;
      const chunks = [];
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > FILE_LIMIT) return req.destroy(redditError('Reddit file is too big'));
        chunks.push(chunk);
      });
      res.on('end', () => {
        const file = `${base}.${ext}`;
        fs.writeFile(file, Buffer.concat(chunks)).then(() => resolve(file), reject);
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(redditError('Timed out downloading from Reddit')));
    req.on('error', reject);
  });
}

// ---------- links ----------

const postKey = (id) => ({ key: `r-${id.toLowerCase()}` });
const share = (url) => ({ share: url, site: 'reddit' });
const UNSUPPORTED = { unsupported: true, site: 'reddit' };

/** The post id in a reddit.com path: /r/<sub>/comments/<id>, /user/<u>/comments/<id>, /comments/<id>. */
function postIdIn(parts) {
  const at = parts.indexOf('comments');
  const id = at >= 0 ? parts[at + 1] : null;
  return id && POST_ID.test(id) ? id : null;
}

/**
 * Finds the first Reddit link in `text`. Returns null (no Reddit link), { key },
 * { share, site: 'reddit' } for share links (pass to resolveRedditShareLink), or
 * { unsupported: true, site: 'reddit' } for subreddits, profiles and other pages.
 */
export function parseRedditLink(text) {
  const match = text.match(REDDIT_URL);
  if (!match) return null;
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(match[0]) ? match[0] : `https://${match[0]}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);

  // redd.it/<post id>
  if (host === 'redd.it' || host === 'www.redd.it') return POST_ID.test(parts[0] ?? '') ? postKey(parts[0]) : UNSUPPORTED;
  // v.redd.it/<video code> redirects to its post
  if (host === 'v.redd.it') return CODE.test(parts[0] ?? '') ? share(`https://v.redd.it/${parts[0]}`) : UNSUPPORTED;
  if (!/(^|\.)reddit\.com$/.test(host)) return UNSUPPORTED; // i.redd.it, preview.redd.it, …

  const id = postIdIn(parts);
  if (id) return postKey(id);
  // /r/<sub>/s/<code> (the app's share links) redirect to the post
  if (parts.length === 4 && ['r', 'u', 'user'].includes(parts[0]) && parts[2] === 's' && CODE.test(parts[1]) && CODE.test(parts[3])) {
    return share(`https://www.reddit.com/${parts[0]}/${parts[1]}/s/${parts[3]}`);
  }
  return UNSUPPORTED;
}

/** The Location of one GET request, or null. */
function redirectOf(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': USER_AGENT, ...headers }, timeout: REQUEST_TIMEOUT_MS }, (res) => {
      res.resume();
      resolve(res.statusCode >= 300 && res.statusCode < 400 ? (res.headers.location ?? null) : null);
    });
    req.on('timeout', () => req.destroy(redditError(`Timed out opening ${url}`)));
    req.on('error', reject);
  });
}

/**
 * Follows a share link's redirects (at most 5) to a post. Returns its key, or null.
 * Share links open without the API; if Reddit blocks that, the API host is tried with the key.
 */
export async function resolveRedditShareLink(url) {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    let location = await redirectOf(current);
    if (!location && hasKey() && new URL(current).hostname === 'www.reddit.com') {
      const apiUrl = current.replace('https://www.reddit.com', 'https://oauth.reddit.com');
      location = await redirectOf(apiUrl, { Authorization: `Bearer ${await accessToken()}` });
    }
    if (!location) return null;
    const next = new URL(location, current);
    const link = parseRedditLink(next.href);
    if (link?.key) return link.key;
    if (!link?.share || link.share === current) {
      // e.g. a login wall: the post id may still be in the URL's query
      return null;
    }
    current = link.share;
  }
  return null;
}
