import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/*
 * Threads: public posts only, no login. yt-dlp has no Threads extractor and the post page
 * carries no post data (the browser loads it afterwards), so the post is read the way
 * threads.com's own page does it: a logged-out POST to /api/graphql with the page's
 * `lsd` token and the id of the "BarcelonaPostPageTargetQuery" query. Files come from
 * Meta's CDN (*.cdninstagram.com, *.fbcdn.net).
 *
 * Key (see KEY_TYPES in instagram.js): th-<post code>, the code from /@user/post/<code>.
 *
 * WHEN IT BREAKS: Threads changes the query id (and the feature-flag variables the query
 * wants) when it updates its site. Symptoms: THREADS_CHANGED errors in the log. To fix it,
 * open a post in a browser, find the POST to /api/graphql whose fb_api_req_friendly_name
 * is BarcelonaPostPageTargetQuery (DevTools → Network) and copy its `doc_id` into
 * THREADS_DOC_ID (or set the THREADS_DOC_ID env var), and the variables named
 * __relay_internal__pv__<name>relayprovider into FLAGS. Checked November 2026.
 */

const THREADS_URL = /(?<![\w.-])(?:https?:\/\/)?(?:www\.)?threads\.(?:com|net)\/[^\s<>"']*/i;
const CODE = /^[\w-]{6,40}$/;
const USERNAME = /^[\w.]{1,30}$/;

const THREADS_DOC_ID = process.env.THREADS_DOC_ID?.trim() || '28481388384869123';
const APP_ID = '238260118697367'; // threads.com's web app id (in every page)
// The query's feature flags. The server refuses the query if one is missing; all false is fine.
const FLAGS = [
  'GenAIRepliesEnabled', 'HasAMAConsumption', 'HasAdditionalLikeCount', 'HasCommunities', 'HasCommunityChampionCard',
  'HasCommunityEmojiUpdateCard', 'HasCommunityEntityCard', 'HasCommunityFounderCard', 'HasCommunityIntroCard',
  'HasCommunityPermalinkPivots', 'HasCommunityTopContributors', 'HasCustomLikesConsumption', 'HasDearAlgoConsumption',
  'HasDearAlgoWebProduction', 'HasEventBadge', 'HasGameScoreShare', 'HasGhostPostEmojiActivation', 'HasGhostPostProduction',
  'HasInsightsMetricShareCard', 'HasInsightsPermalinkUFI', 'HasKeyboardShortcuts', 'HasLiveChatHostlessUI',
  'HasLocalTrendLabelInFeed', 'HasMWRConsumption', 'HasMembersOnlyReplyConsumption', 'HasMessaging',
  'HasMetaAiContentAttachments', 'HasMiddlemistConsumption', 'HasNewsletterLinkPreview', 'HasNewspaperLinkStyle',
  'HasPodcastTranscriptConsumption', 'HasPodcastV2Consumption', 'HasPodcastV2Production', 'HasPrivateRepliesDeprecation',
  'HasProfileUpdatePost', 'HasPublicViewCountCard', 'HasPublicViewCountShareCard', 'HasSaveCount', 'HasScorecardCommunity',
  'HasSportTeamAllegianceCard', 'HasStitchedAttachment', 'HasThreadsFriendsApplication', 'HasTopLevelSaveButton',
  'HasUFINotInterested', 'HasUnseenReplies', 'HasViewerReplied', 'HasWebFavicons', 'IsCrawler', 'IsDesktop',
  'IsInternalUser', 'IsLoggedIn', 'IsLoggedOutShareTestEnabled', 'IsSearchDiscoveryEnabled', 'MessagesHasLiveChatMessaging',
  'MessagingHasMetaAIBot', 'OptionalCookiesEnabled', 'QuotedPostParentCaptionEnabled', 'ShouldFetchPostAuthorFullName',
  'ShouldFulfillLightboxQuery', 'ShouldShowFediverseM075Features', 'ShouldShowFediverseM1Features',
];

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT_MS = 20_000;
const VIDEO_LIMIT = 49 * 1024 * 1024; // Telegram's 50 MB upload limit for bots, with some room
const FILE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'video/mp4': 'mp4' };

const threadsError = (message, extra) => Object.assign(new Error(message), { source: 'threads', ...extra });

// ---------- the post ----------

/** A post code (Instagram-style base64) as its numeric media id. */
function mediaIdOf(code) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let id = 0n;
  for (const char of code.slice(0, 11)) id = id * 64n + BigInt(alphabet.indexOf(char));
  return id.toString();
}

/** The `lsd` token and cookies a logged-out visitor gets from threads.com. */
async function session() {
  const res = await fetch('https://www.threads.com/', {
    headers: { 'User-Agent': BROWSER_UA, 'Sec-Fetch-Mode': 'navigate' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 429) throw threadsError('Threads is rate-limiting requests', { code: 'THREADS_RATE_LIMIT' });
  const html = await res.text();
  const lsd = html.match(/"LSD",\[\],\{"token":"([^"]+)"/)?.[1];
  if (!res.ok || !lsd) throw threadsError(`threads.com answered HTTP ${res.status} without a token`, { code: 'THREADS_CHANGED' });
  const cookies = res.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; ');
  return { lsd, cookies };
}

/**
 * Reads a post. Threads sometimes answers Render's server with 429 even when it's been quiet,
 * so a 429 is retried once, after a pause and with a fresh session, before giving up.
 */
async function fetchPost(code) {
  try {
    return await queryPost(code);
  } catch (err) {
    if (err.code !== 'THREADS_RATE_LIMIT') throw err;
    console.warn(`[th-${code}] ${err.message}; retrying in 5 s`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    return queryPost(code);
  }
}

async function queryPost(code) {
  const { lsd, cookies } = await session();
  const variables = { postID: mediaIdOf(code) };
  for (const flag of FLAGS) variables[`__relay_internal__pv__Barcelona${flag}relayprovider`] = false;
  const res = await fetch('https://www.threads.com/api/graphql', {
    method: 'POST',
    headers: {
      'User-Agent': BROWSER_UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-FB-LSD': lsd,
      'X-IG-App-ID': APP_ID,
      'Sec-Fetch-Site': 'same-origin',
      Origin: 'https://www.threads.com',
      Referer: `https://www.threads.com/t/${code}`,
      ...(cookies ? { Cookie: cookies } : {}),
    },
    body: new URLSearchParams({ lsd, doc_id: THREADS_DOC_ID, variables: JSON.stringify(variables) }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (res.status === 429) {
    // What Threads says with it (no cookies or tokens in it), to tell a real limit from a block
    const why = text.replace(/\s+/g, ' ').slice(0, 300);
    throw threadsError(`Threads answered the post query with HTTP 429: ${why}`, { code: 'THREADS_RATE_LIMIT' });
  }
  let body;
  try {
    body = JSON.parse(text.replace(/^for \(;;\);/, ''));
  } catch {
    throw threadsError(`Threads answered HTTP ${res.status} with something that isn't JSON`, { code: 'THREADS_CHANGED' });
  }
  const media = body?.data?.media;
  if (media) return media;
  if (body?.errors?.length) {
    // A changed query id or a new required flag shows up as a server error
    throw threadsError(`Threads query failed: ${body.errors[0]?.message}`, { code: 'THREADS_CHANGED' });
  }
  throw threadsError(`Threads post ${code} not found`, { code: 'THREADS_GONE' });
}

/** The biggest image of an item, or null. */
const bestImage = (media) =>
  (media?.image_versions2?.candidates ?? [])
    .filter((candidate) => candidate?.url)
    .sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0] ?? null;

/** One photo or video of a post as { kind, urls (best first), width, height }, or null. */
function itemOf(media) {
  const videos = (media?.video_versions ?? []).filter((version) => version?.url);
  if (videos.length) {
    const urls = [...new Set(videos.sort((a, b) => (b.width ?? 0) - (a.width ?? 0)).map((version) => version.url))];
    return { kind: 'video', urls, width: media.original_width, height: media.original_height };
  }
  const image = bestImage(media);
  return image ? { kind: 'photo', urls: [image.url], width: image.width, height: image.height } : null;
}

/** Reads a post. Returns { username, name, items }. */
async function readPost(code) {
  const post = await fetchPost(code);
  if (post.text_post_app_info?.is_post_unavailable) throw threadsError(`Threads post ${code} is unavailable`, { code: 'THREADS_GONE' });
  const parts = post.carousel_media?.length ? post.carousel_media : [post];
  const items = parts.map(itemOf).filter(Boolean);
  if (items.length === 0) throw threadsError(`Threads post ${code} has no photos or videos`, { code: 'NO_MEDIA' });
  return { username: post.user?.username ?? null, name: post.user?.full_name || null, items };
}

// ---------- files ----------

const allowedHost = (url) =>
  url.protocol === 'https:' && (url.hostname.endsWith('.cdninstagram.com') || url.hostname.endsWith('.fbcdn.net'));

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

/** Downloads a photo or video from Meta's CDN to `<base>.<ext>`. Returns the path. */
async function downloadFile(fileUrl, base) {
  const url = new URL(fileUrl);
  if (!allowedHost(url)) throw threadsError(`Not a Threads media URL: ${url.hostname}`);
  const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(5 * 60_000) });
  const ext = FILE_EXT[res.headers.get('content-type')?.split(';')[0].trim()];
  if (!res.ok || !ext) throw threadsError(`HTTP ${res.status} (${res.headers.get('content-type')}) for a Threads file`);
  const file = `${base}.${ext}`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
  return file;
}

/**
 * Downloads every photo and video of the Threads post a key points at into `dir`, in order.
 * A failed item makes the result partial. Returns the same shape as downloadMedia.
 */
export async function downloadThreadsPost(key, request, dir) {
  const post = await readPost(request.threadsCode);
  const items = [];
  let partial = false;
  for (const [i, item] of post.items.entries()) {
    try {
      const file = await downloadFile(await pickUrl(item), path.join(dir, `${String(i + 1).padStart(2, '0')}-${item.kind}`));
      items.push({ file, kind: file.endsWith('.mp4') ? 'video' : 'photo', width: item.width, height: item.height });
    } catch (err) {
      console.warn(`[${key}] item ${i + 1} failed:`, err.message);
      partial = true;
    }
  }
  if (items.length === 0) throw threadsError(`Nothing in ${key} could be downloaded`);
  return { author: post.name, username: USERNAME.test(post.username ?? '') ? post.username : null, partial, items };
}

// ---------- links ----------

/**
 * Finds the first threads.com / threads.net link in `text`. Returns null, { key: 'th-<code>' }
 * for a post (/@user/post/<code>, /t/<code>), { share, site: 'threads' } for the app's
 * /share/<code> links (pass to resolveThreadsShareLink), or { unsupported: true, site: 'threads' }.
 */
export function parseThreadsLink(text) {
  const match = text.match(THREADS_URL);
  if (!match) return null;
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(match[0]) ? match[0] : `https://${match[0]}`);
  } catch {
    return null;
  }
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === 'share' && CODE.test(parts[1] ?? '')) return { share: `https://www.threads.com/share/${parts[1]}`, site: 'threads' };
  const code = parts[0]?.startsWith('@') && parts[1] === 'post' ? parts[2] : parts[0] === 't' ? parts[1] : null;
  return code && CODE.test(code) ? { key: `th-${code}` } : { unsupported: true, site: 'threads' };
}

/**
 * Follows a /share/<code> link's redirects (at most 3) to the post. Threads answers a desktop
 * browser with a page that redirects in JavaScript, but anything else with a 302, so this sends
 * a curl User-Agent. Returns the post's key, or null.
 */
export async function resolveThreadsShareLink(url) {
  let current = url;
  for (let hop = 0; hop < 3; hop++) {
    const res = await fetch(current, { headers: { 'User-Agent': 'curl/8' }, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    const location = res.headers.get('location');
    if (!location || res.status < 300 || res.status >= 400) return null;
    const next = new URL(location, current);
    if (!/^(?:www\.)?threads\.(?:com|net)$/.test(next.hostname)) return null;
    const link = parseThreadsLink(next.href);
    if (link?.key) return link.key;
    if (!link?.share || link.share === current) return null;
    current = link.share;
  }
  return null;
}
