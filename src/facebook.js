import fs from 'node:fs/promises';
import https from 'node:https';

/*
 * Facebook links. A link becomes a key (see KEY_TYPES in instagram.js) built only from
 * validated ids, and requestFor rebuilds the URL from it, so text from the message never
 * reaches yt-dlp or a request:
 *   f-<video id>          a video or reel (yt-dlp)
 *   fp-<page>-<post id>   a post: its photos are read from the post's page (yt-dlp only
 *                         handles videos), its videos go through yt-dlp
 *   fph-<photo id>        a single photo (photo.php?fbid=…), read from the photo's page
 * Profiles and other pages are "unsupported".
 */

// The first Facebook link in a message: facebook.com (any subdomain: www, m, web, …),
// fb.com, or the fb.watch short links. The lookbehind stops "notfacebook.com" matching.
const FB_URL = /(?<![\w.-])(?:https?:\/\/)?(?:[\w-]+\.)*(?:facebook\.com|fb\.com|fb\.watch)\/[^\s<>"']*/i;
const CODE = /^[\w-]+$/; // share-link codes
const VIDEO_ID = /^\d{1,25}$/;
const WATCH_PATHS = new Set(['watch', 'video.php']); // …/watch/?v=<id>, /watch/live/?v=<id>, /video.php?v=<id>
const POST_PATHS = new Set(['story.php', 'permalink.php']); // ?story_fbid=<post id>&id=<page id>
const PAGE = /^[\w.]{1,30}$/; // a page's username or numeric id (fits the 64-byte callback data)
const LONG_PAGE = /^[\w.]{1,80}$/;
// Newer post ids ("pfbid0abc…") are too long for button data; the post page gives the numeric id.
const PFBID = /^pfbid[0-9A-Za-z]{10,100}$/;
const PHOTO_PATHS = new Set(['photo.php', 'photo']); // photo.php?fbid=<id>, /photo/?fbid=<id>

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/** The redirect target of one GET request, or null if the response isn't a redirect. */
function redirectOf(url) {
  return new Promise((resolve, reject) => {
    // Facebook answers share links with HTTP 400 unless the request looks like a browser
    // opening a page ("Sec-Fetch-Mode: navigate"). Node's fetch always overwrites that header
    // with "cors", so this uses node:https, which sends the headers as given.
    const req = https.get(
      url,
      { headers: { 'User-Agent': BROWSER_UA, 'Sec-Fetch-Mode': 'navigate' }, timeout: 15_000 },
      (res) => {
        res.resume(); // the body isn't needed
        resolve(res.statusCode >= 300 && res.statusCode < 400 ? (res.headers.location ?? null) : null);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`Timed out opening ${url}`)));
    req.on('error', reject);
  });
}

const PAGE_LIMIT = 8 * 1024 * 1024; // a post page is about 1 MB

/**
 * The HTML of a Facebook page, loaded the way a logged-out browser would. Follows up to 3
 * redirects within www.facebook.com (a post can redirect to its video's page, for example).
 */
function fetchPage(url, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': BROWSER_UA,
          'Sec-Fetch-Mode': 'navigate', // see redirectOf
          Accept: 'text/html',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        timeout: 15_000,
      },
      (res) => {
        const location = res.statusCode >= 300 && res.statusCode < 400 && res.headers.location;
        const next = location && new URL(location, url);
        if (next?.protocol === 'https:' && next.hostname === 'www.facebook.com' && redirectsLeft > 0) {
          res.resume();
          return resolve(fetchPage(next.href, redirectsLeft - 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        let size = 0;
        const chunks = [];
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > PAGE_LIMIT) return req.destroy(new Error(`${url} is too big`));
          chunks.push(chunk);
        });
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`Timed out loading ${url}`)));
    req.on('error', reject);
  });
}

// ---------- reading Facebook's pages ----------

/** The JSON data blocks a Facebook page embeds in <script type="application/json"> tags. */
function* dataBlocks(html) {
  for (const [, json] of html.matchAll(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      yield JSON.parse(json);
    } catch {
      // not JSON after all; skip it
    }
  }
}

/** Every object inside `value`, with the key it sits under. */
function* objects(value, key) {
  if (Array.isArray(value)) {
    for (const item of value) yield* objects(item, key);
  } else if (value && typeof value === 'object') {
    yield [value, key];
    for (const [k, v] of Object.entries(value)) yield* objects(v, k);
  }
}

function find(html, test) {
  for (const block of dataBlocks(html)) {
    for (const [obj, key] of objects(block)) if (test(obj, key)) return obj;
  }
  return null;
}

const digits = (value) => (VIDEO_ID.test(String(value ?? '')) ? String(value) : null);

/**
 * The post itself: the page's top-level story (`node_v2`). Comments and suggested posts
 * have their own attachments deeper in the page, so nothing else on the page is used.
 */
const findStory = (html, postId) =>
  find(html, (obj, key) => key === 'node_v2' && obj.post_id && (!postId || obj.post_id === postId) && Array.isArray(obj.attachments));

function mediaItem(media) {
  const id = digits(media?.id);
  if (!id) return null;
  if (media.__typename === 'Video') return { kind: 'video', id };
  if (media.__typename !== 'Photo') return null;
  // Single-photo posts have the full image under photo_image (viewer_image gives its size);
  // multi-photo posts have it under viewer_image; `image` is a smaller preview.
  const size = media.viewer_image ?? {};
  const image = size.uri ? size : media.photo_image?.uri ? { ...media.photo_image, ...size, uri: media.photo_image.uri } : media.image;
  return image?.uri ? { kind: 'photo', id, url: image.uri, width: image.width, height: image.height } : null;
}

/** The photos and videos attached to a story, in order, and how many it says it has. */
function storyMedia(story) {
  const items = [];
  let total = 0;
  for (const attachment of story.attachments ?? []) {
    const a = attachment?.styles?.attachment;
    const nodes = a?.all_subattachments?.nodes;
    const medias = nodes ? nodes.map((node) => node?.media) : a?.media ? [a.media] : [];
    total += nodes ? Math.max(a.all_subattachments.count ?? 0, nodes.length) : medias.length;
    items.push(...medias.map(mediaItem).filter(Boolean));
  }
  // A post that shares another post has its media on the shared one.
  if (!items.length && story.attached_story) return storyMedia(story.attached_story);
  return { items, total };
}

const actorOf = (story) => story?.actors?.find((actor) => actor?.name) ?? null;

/**
 * Reads a post's page. Returns { author, uploaderId, items, total }, where items are
 * { kind: 'photo', id, url, width, height } or { kind: 'video', id } in the post's order,
 * and `total` is how many the post has (Facebook lists only some to logged-out visitors).
 * Returns null if the page has no such post.
 */
export async function readFacebookPost(postUrl, postId) {
  const story = findStory(await fetchPage(postUrl), postId);
  if (!story) return null;
  const actor = actorOf(story);
  return { author: actor?.name, uploaderId: digits(actor?.id), ...storyMedia(story) };
}

/** Reads a photo's page. Returns { author, uploaderId, item } or null. */
export async function readFacebookPhoto(photoUrl, photoId) {
  const html = await fetchPage(photoUrl);
  const media = find(html, (obj, key) => key === 'currMedia' && obj.id === photoId && obj.image?.uri);
  if (!media) return null;
  const actor = actorOf(media.container_story);
  const item = { kind: 'photo', id: photoId, url: media.image.uri, width: media.image.width, height: media.image.height };
  return { author: actor?.name, uploaderId: digits(actor?.id ?? media.owner?.id), item };
}

const IMAGE_LIMIT = 30 * 1024 * 1024;
const IMAGE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/**
 * Downloads a photo from Facebook's image servers to `<base>.<ext>` and returns the path.
 * Only https URLs on *.fbcdn.net are fetched (they come from Facebook's page, not the user).
 */
export function downloadImage(imageUrl, base) {
  const url = new URL(imageUrl);
  if (url.protocol !== 'https:' || !/(^|\.)fbcdn\.net$/i.test(url.hostname)) {
    return Promise.reject(new Error(`Not a Facebook image URL: ${url.hostname}`));
  }
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': BROWSER_UA }, timeout: 30_000 }, (res) => {
      const ext = IMAGE_EXT[res.headers['content-type']?.split(';')[0].trim()];
      if (res.statusCode !== 200 || !ext) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} (${res.headers['content-type']}) for a Facebook image`));
      }
      let size = 0;
      const chunks = [];
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > IMAGE_LIMIT) return req.destroy(new Error('Facebook image is too big'));
        chunks.push(chunk);
      });
      res.on('end', () => {
        const file = `${base}.${ext}`;
        fs.writeFile(file, Buffer.concat(chunks)).then(() => resolve(file), reject);
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Timed out downloading a Facebook image')));
    req.on('error', reject);
  });
}

// ---------- links ----------

/** A post's key from its page, for links with a "pfbid…" id: fp-<page id>-<numeric post id>. */
async function postKeyFromPage(postUrl) {
  const story = findStory(await fetchPage(postUrl));
  const postId = digits(story?.post_id);
  const pageId = digits(actorOf(story)?.id);
  return postId && pageId ? `fp-${pageId}-${postId}` : null;
}

/**
 * Follows a fb.watch/…, facebook.com/share/… or "pfbid" post link to what it points at and
 * returns its key, or null if it doesn't lead anywhere downloadable (e.g. the login page).
 */
export async function resolveFacebookShareLink(url) {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const location = await redirectOf(current);
    if (!location) return parseFacebookLink(current)?.pfbid ? postKeyFromPage(current) : null;
    current = new URL(location, current).href;
    if (!current.startsWith('https:')) return null;
    const link = parseFacebookLink(current);
    if (link?.key) return link.key;
    if (!link?.share) return null;
    current = link.share; // rebuilt from the link's validated parts
  }
  return null;
}

const facebookKey = (id) => ({ key: `f-${id}` });
const postKey = (page, post) => ({ key: `fp-${page}-${post}` });
const photoKey = (id) => ({ key: `fph-${id}` });
const share = (url) => ({ share: url, site: 'facebook' });
// A post link with a "pfbid…" id: resolveFacebookShareLink reads the numeric id from its page.
const pfbidPost = (url) => ({ ...share(url), pfbid: true });
const UNSUPPORTED = { unsupported: true, site: 'facebook' };

/**
 * Finds the first Facebook link in `text`. Returns
 *   null                                  no Facebook link
 *   { key }                               a video, reel, post or photo
 *   { share: url, site: 'facebook' }      fb.watch/…, facebook.com/share/… or a "pfbid" post;
 *                                         pass it to resolveFacebookShareLink
 *   { unsupported: true, site: 'facebook' }  a profile or other page
 */
export function parseFacebookLink(text) {
  const match = text?.match(FB_URL);
  if (!match) return null;
  let url;
  try {
    url = new URL(/^https?:/i.test(match[0]) ? match[0] : `https://${match[0]}`);
  } catch {
    return UNSUPPORTED;
  }
  const host = url.hostname.toLowerCase();
  const seg = url.pathname.split('/').filter(Boolean);
  const kind = seg[0]?.toLowerCase();

  // fb.watch/<code>: a short link to a video; only Facebook knows which one
  if (host === 'fb.watch' || host.endsWith('.fb.watch')) {
    return seg.length === 1 && CODE.test(seg[0]) ? share(`https://fb.watch/${seg[0]}/`) : UNSUPPORTED;
  }

  // facebook.com/share/<code>, /share/v/<code> (video), /share/r/<code> (reel), /share/p/<code> (post)
  if (kind === 'share') {
    const parts = seg.slice(1);
    if (parts.length >= 1 && parts.length <= 2 && parts.every((p) => CODE.test(p))) {
      return share(`https://www.facebook.com/share/${parts.join('/')}/`);
    }
    return UNSUPPORTED;
  }

  const v = url.searchParams.get('v');
  if (WATCH_PATHS.has(kind) && VIDEO_ID.test(v ?? '')) return facebookKey(v);

  // A post, e.g. where a facebook.com/share/… link leads: story.php?story_fbid=<post id>&id=<page id>,
  // or /<page>/posts/<post id>. Newer "pfbid…" post ids are resolved through the post's page.
  const storyId = url.searchParams.get('story_fbid') ?? '';
  const pageId = url.searchParams.get('id') ?? '';
  if (POST_PATHS.has(kind) && VIDEO_ID.test(pageId)) {
    if (VIDEO_ID.test(storyId)) return postKey(pageId, storyId);
    if (PFBID.test(storyId)) return pfbidPost(`https://www.facebook.com/story.php?story_fbid=${storyId}&id=${pageId}`);
  }
  if (seg[1]?.toLowerCase() === 'posts' && seg[2]) {
    if (PAGE.test(seg[0]) && VIDEO_ID.test(seg[2])) return postKey(seg[0], seg[2]);
    // pfbid ids, and numeric ones under a page name too long for a key
    if (LONG_PAGE.test(seg[0]) && (PFBID.test(seg[2]) || VIDEO_ID.test(seg[2]))) return pfbidPost(`https://www.facebook.com/${seg[0]}/posts/${seg[2]}/`);
  }

  // One photo: photo.php?fbid=<id>, /photo/?fbid=<id>, /<page>/photos/<album>/<id>/
  const fbid = url.searchParams.get('fbid') ?? '';
  if (PHOTO_PATHS.has(kind) && VIDEO_ID.test(fbid)) return photoKey(fbid);
  if (seg[1]?.toLowerCase() === 'photos' && VIDEO_ID.test(seg.at(-1))) return photoKey(seg.at(-1));

  // facebook.com/reel/<id>
  if (kind === 'reel' && VIDEO_ID.test(seg[1] ?? '')) return facebookKey(seg[1]);

  // facebook.com/<page>/videos/<id>/, also /videos/<title slug>/<id>/ and /videos/vb.<n>/<id>/
  const videos = seg.findIndex((s) => s.toLowerCase() === 'videos');
  const id = videos >= 0 ? seg.slice(videos + 1).findLast((s) => VIDEO_ID.test(s)) : undefined;
  if (id) return facebookKey(id);

  return UNSUPPORTED;
}
