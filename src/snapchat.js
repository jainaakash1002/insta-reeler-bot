import { createHash } from 'node:crypto';
import { createWriteStream, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/*
 * Snapchat: public content only, read from snapchat.com's logged-out pages (no login, no API
 * key). yt-dlp's Snapchat extractor is broken (Snapchat moved Spotlight to a new page format),
 * so the pages are read here and the media files are downloaded directly from sc-cdn.net.
 *
 * Keys (see KEY_TYPES in instagram.js); requestFor rebuilds the page URL from them:
 *   scu-<username>          the user's current public story
 *   sch-<username>-<uuid>   one saved highlight (/@<user>/highlight/<uuid>)
 *   scs-<16 chars>          a Spotlight video. Its id (~59 chars) doesn't fit the 64-byte
 *                           button data, so the key is a hash and the id is kept in ID_FILE.
 *
 * What the pages hold:
 *   profile    __NEXT_DATA__ props.pageProps.story.snapList (current story) and userProfile
 *   highlight  __NEXT_DATA__ props.pageProps.highlight.snapList and publicUserProfile
 *   spotlight  a schema.org VideoObject in <script type="application/ld+json">: contentUrl,
 *              creator.alternateName (username), creator.name, width, height, duration
 * A snap is { snapMediaType: 0 photo | 1 video, snapUrls.mediaUrl }. Text and stickers drawn
 * on a snap are a separate overlay image, which isn't added.
 */

// snapchat.com (www, story, t, …). The lookbehind stops "notsnapchat.com" matching.
const SNAP_URL = /(?<![\w.-])(?:https?:\/\/)?(?:[\w-]+\.)*snapchat\.com\/[^\s<>"']*/i;
const USERNAME = /^[a-z0-9][\w.-]{0,14}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SPOTLIGHT_ID = /^[\w-]{20,120}$/;
const CODE = /^[\w-]{1,60}$/;

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT_MS = 20_000;
const FILE_LIMIT = 200 * 1024 * 1024;
const FILE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4' };

const snapError = (message, extra) => Object.assign(new Error(message), { source: 'snapchat', ...extra });

// ---------- Spotlight ids ----------

const ID_FILE = path.join(os.tmpdir(), 'insta-reel-bot-snapchat-ids.json');
const spotlightIds = (() => {
  try {
    return new Map(Object.entries(JSON.parse(readFileSync(ID_FILE, 'utf8'))));
  } catch {
    return new Map();
  }
})();
let saving = Promise.resolve();

/** The short key part for a long Spotlight or snap id; remembers the id so the key can be turned back into it. */
function spotlightHash(id) {
  const hash = createHash('sha256').update(id).digest('base64url').slice(0, 16);
  if (spotlightIds.get(hash) !== id) {
    spotlightIds.set(hash, id);
    const data = JSON.stringify(Object.fromEntries(spotlightIds));
    saving = saving.then(() => fs.writeFile(ID_FILE, data)).catch((err) => console.warn('Saving Snapchat ids:', err.message));
  }
  return hash;
}

/** The Spotlight or snap id for a key's hash, or null if it isn't known (e.g. the temp folder was cleared). */
export function spotlightIdFor(hash) {
  const id = spotlightIds.get(hash);
  return id && SPOTLIGHT_ID.test(id) ? id : null;
}

// ---------- pages ----------

/** A snapchat.com page's HTML. Redirects are followed, but only within www.snapchat.com. */
async function fetchPage(url) {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(current, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const location = res.status >= 300 && res.status < 400 && res.headers.get('location');
    if (location) {
      const next = new URL(location, current);
      if (next.protocol !== 'https:' || next.hostname !== 'www.snapchat.com') {
        throw snapError(`Snapchat redirected to ${next.hostname}`);
      }
      current = next.href;
      continue;
    }
    if (res.status === 404) throw snapError(`HTTP 404 for ${url}`, { code: 'NO_MEDIA' });
    if (!res.ok) throw snapError(`HTTP ${res.status} for ${url}`);
    return res.text();
  }
  throw snapError(`Too many redirects for ${url}`);
}

const nextData = (html) => {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  return match ? JSON.parse(match[1])?.props?.pageProps : null;
};

function* ldJson(html) {
  for (const match of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      yield JSON.parse(match[1]);
    } catch {
      // not JSON: skip it
    }
  }
}

const KIND = { 0: 'photo', 1: 'video' };

/** A story or highlight's snaps as items: { kind, url, id }. */
const snapItems = (story) =>
  (story?.snapList ?? []).flatMap((snap, i) => {
    const kind = KIND[snap?.snapMediaType];
    const url = snap?.snapUrls?.mediaUrl;
    return kind && url ? [{ kind, url, id: `snap${i + 1}` }] : [];
  });

const profileOf = (props) => {
  const profile = props?.userProfile?.publicProfileInfo ?? props?.publicUserProfile ?? null;
  return { username: profile?.username ?? null, name: profile?.title || null };
};

/**
 * Some Spotlight pages leave out their own video (only an "up next" list of other videos is
 * there). The creator's profile lists their recent Spotlights with direct links, so look there.
 */
async function spotlightFromProfile(html, request) {
  const user = html.match(/<link rel="canonical" href="https:\/\/www\.snapchat\.com\/@([\w.-]{1,30})\/spotlight\//)?.[1];
  const props = user && USERNAME.test(user) ? nextData(await fetchPage(`https://www.snapchat.com/@${user}`)) : null;
  const spotlight = props?.spotlightHighlights?.find((entry) => entry?.storyId?.value === request.spotlightId);
  const items = snapItems(spotlight).slice(0, 1).map((item) => ({ ...item, kind: 'video', id: 'spotlight' }));
  if (items.length === 0) throw snapError(`No video for the Spotlight ${request.url}`, { code: 'SPOTLIGHT_HIDDEN' });
  return { ...profileOf(props), items };
}

/** Reads the page for a request from requestFor. Returns { username, name, title, items }. */
async function readSnapchat(request) {
  const html = await fetchPage(request.url);
  if (request.snapchat === 'spotlight') {
    const video = [...ldJson(html)].find((item) => item?.['@type'] === 'VideoObject' && item.contentUrl);
    if (!video) return spotlightFromProfile(html, request);
    return {
      username: video.creator?.alternateName ?? null,
      name: video.creator?.name ?? null,
      items: [{ kind: 'video', url: video.contentUrl, id: 'spotlight', width: video.width, height: video.height }],
    };
  }
  const props = nextData(html);
  if (!props) throw snapError(`No data on the Snapchat page ${request.url}`);
  const story = request.snapchat === 'highlight' ? props.highlight : props.story;
  let items = snapItems(story);
  if (request.snapId) {
    // a link to one snap of a story: just that snap
    const at = (story?.snapList ?? []).findIndex((snap) => snap?.snapId?.value === request.snapId);
    const item = at >= 0 && snapItems({ snapList: [story.snapList[at]] })[0];
    if (!item) throw snapError(`Snap ${request.snapId} isn't in the story anymore`, { code: 'SNAP_GONE' });
    items = [{ ...item, id: `snap${at + 1}` }];
  }
  if (items.length === 0) {
    throw snapError(`Nothing in ${request.url}`, { code: request.snapchat === 'story' ? 'NO_STORY' : 'NO_MEDIA' });
  }
  return { ...profileOf(props), title: story?.storyTitle?.value ?? null, items };
}

/** Downloads a media file from Snapchat's CDN (*.sc-cdn.net) to `<base>.<ext>`. Returns the path. */
async function downloadFile(fileUrl, base) {
  const url = new URL(fileUrl);
  if (url.protocol !== 'https:' || !/(^|\.)sc-cdn\.net$/i.test(url.hostname)) {
    throw snapError(`Not a Snapchat media URL: ${url.hostname}`);
  }
  const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(5 * 60_000) });
  const ext = FILE_EXT[res.headers.get('content-type')?.split(';')[0].trim()];
  if (!res.ok || !ext) throw snapError(`HTTP ${res.status} (${res.headers.get('content-type')}) for a Snapchat file`);
  if (Number(res.headers.get('content-length')) > FILE_LIMIT) throw snapError('Snapchat file is too big');
  const file = `${base}.${ext}`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
  return file;
}

/**
 * Downloads everything a Snapchat key points at into `dir`, in order. A failed item makes the
 * result partial. Returns the same shape as downloadMedia.
 */
export async function downloadSnapchat(key, request, dir) {
  const page = await readSnapchat(request);
  const items = [];
  let partial = false;
  for (const [i, item] of page.items.entries()) {
    try {
      const file = await downloadFile(item.url, path.join(dir, `${String(i + 1).padStart(2, '0')}-${item.id}`));
      // the snap type says photo or video; the file's type is the final word
      items.push({ file, kind: file.endsWith('.mp4') ? 'video' : 'photo', width: item.width, height: item.height });
    } catch (err) {
      console.warn(`[${key}] item ${i + 1} failed:`, err.message);
      partial = true;
    }
  }
  if (items.length === 0) throw snapError(`Nothing in ${key} could be downloaded`);
  return { author: page.name, username: page.username, title: page.title, partial, items };
}

// ---------- links ----------

const UNSUPPORTED = { unsupported: true, site: 'snapchat' };
const share = (url) => ({ share: url, site: 'snapchat' });

/**
 * Finds the first snapchat.com link in `text`. Returns null (no Snapchat link), { key },
 * { share, site: 'snapchat' } for short links (pass to resolveSnapchatShareLink), or
 * { unsupported: true, site: 'snapchat' } for lenses and other pages.
 */
export function parseSnapchatLink(text) {
  const match = text.match(SNAP_URL);
  if (!match) return null;
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(match[0]) ? match[0] : `https://${match[0]}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });

  // short links from the app: t.snapchat.com/<code>, snapchat.com/t/<code>
  if (host === 't.snapchat.com') return CODE.test(parts[0] ?? '') ? share(`https://t.snapchat.com/${parts[0]}`) : UNSUPPORTED;
  if (parts[0] === 't' && CODE.test(parts[1] ?? '')) return share(`https://www.snapchat.com/t/${parts[1]}`);

  // /spotlight/<id>, /@<user>/spotlight/<id>, /add/<user>/spotlight/<id>
  if (parts[0] === 'o') parts[0] = 'spotlight'; // story.snapchat.com/o/<id> is a Spotlight
  if (parts[0] === 'u') parts[0] = 'add'; // story.snapchat.com/u/<user>[/<snap id>]
  const spot = parts.indexOf('spotlight');
  if (spot >= 0) {
    const id = parts[spot + 1];
    return id && SPOTLIGHT_ID.test(id) ? { key: `scs-${spotlightHash(id)}` } : UNSUPPORTED;
  }

  // the user: /@<user>/…, /add/<user>/…, story.snapchat.com/@<user> or /s/<user>
  let user = null;
  let rest = [];
  if (parts[0]?.startsWith('@')) [user, rest] = [parts[0].slice(1), parts.slice(1)];
  else if ((parts[0] === 'add' || parts[0] === 's') && parts[1]) [user, rest] = [parts[1], parts.slice(2)];
  if (!user || !USERNAME.test(user)) return UNSUPPORTED;
  user = user.toLowerCase();

  if (rest[0] === 'highlight') return UUID.test(rest[1] ?? '') ? { key: `sch-${user}-${rest[1].toLowerCase()}` } : UNSUPPORTED;
  if (rest.length === 0 || rest[0] === 'story') return { key: `scu-${user}` };
  // /@<user>/<snap id>: one snap of the user's story
  if (rest.length === 1 && SPOTLIGHT_ID.test(rest[0])) return { key: `scn-${user}-${spotlightHash(rest[0])}` };
  return UNSUPPORTED; // lenses, the user's Spotlight tab, …
}

/** Follows a short link's redirects (at most 5) to a page the bot can download. Returns its key, or null. */
export async function resolveSnapchatShareLink(url) {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const res = await fetch(current, {
      headers: { 'User-Agent': BROWSER_UA },
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const location = res.headers.get('location');
    if (!location || res.status < 300 || res.status >= 400) return null;
    const next = new URL(location, current);
    const link = parseSnapchatLink(next.href);
    if (link?.key) return link.key;
    if (!link?.share || link.share === current) return null;
    current = link.share;
  }
  return null;
}
