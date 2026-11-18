import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000; // a highlight can have 100 items
// yt-dlp only downloads Instagram videos; this plugin adds photos (see the file for details).
const PLUGIN_DIR = path.join(import.meta.dirname, '..', 'yt-dlp-plugins');
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// The first Instagram link in a message. The scheme is optional so "instagram.com/p/…" works too.
const IG_URL = /(?:https?:\/\/)?(?:www\.|m\.)?(?:instagram\.com|instagr\.am)\/[^\s<>"']*/i;
const CODE = /^[\w-]+$/; // post shortcodes and share-link codes
const USERNAME = /^\w[\w.]*$/; // letters, digits, _ and .
const DIGITS = /^\d+$/;
const POST_PATHS = new Set(['p', 'reel', 'reels', 'tv']);

// Fields yt-dlp prints for each downloaded item (filepath is where it was saved).
const ITEM_FIELDS = 'filepath,id,ext,width,height,duration,description,channel,uploader';
const PHOTO_EXT = /^(jpe?g|png|webp|heic)$/i;

/*
 * Everything the bot downloads is identified by a "key". The key names the cache
 * folder and is carried in the screenshot buttons' callback data (64 bytes max), so
 * it is short and uses only [\w.-]. It is also the only thing that reaches yt-dlp:
 * the URL is rebuilt from the key's validated parts, never taken from the message.
 *
 *   p-<shortcode>            reel, video or photo post, carousel
 *   s-<username>-<story pk>  one story
 *   u-<username>             all of a user's current stories
 *   h-<highlight id>         a whole highlight
 *   h-<highlight id>-<pk>    one item of a highlight
 */
const KEY_TYPES = [
  [/^p-([\w-]+)$/, ([, code]) => ({ url: `https://www.instagram.com/p/${code}/` })],
  [
    /^s-(\w[\w.]*)-(\d+)$/,
    ([, user, pk]) => ({
      url: `https://www.instagram.com/stories/${user}/${pk}/`,
      args: ['--no-playlist'], // without it yt-dlp downloads all of the user's stories
      story: true,
    }),
  ],
  [/^u-(\w[\w.]*)$/, ([, user]) => ({ url: `https://www.instagram.com/stories/${user}/`, story: true })],
  [
    /^h-(\d+)(?:-(\d+))?$/,
    ([, id, pk]) => ({
      url: `https://www.instagram.com/stories/highlights/${id}/`,
      args: pk ? ['--match-filters', `id='${pkToId(pk)}'`] : [],
      story: true,
    }),
  ],
];

/** Returns { url, args, story } for a valid key, or null. */
export function requestFor(key) {
  for (const [pattern, build] of KEY_TYPES) {
    const match = key?.match(pattern);
    if (match) return { args: [], story: false, ...build(match) };
  }
  return null;
}

/** Stories and highlights only download with an Instagram login (cookies). */
export const needsLogin = (key) => requestFor(key)?.story === true;
export const hasLogin = () => Boolean(process.env.IG_COOKIES_FILE || process.env.IG_COOKIES_FROM_BROWSER);

// yt-dlp ids story items by their numeric pk written in Instagram's base64 alphabet.
const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function pkToId(pk) {
  let n = BigInt(pk);
  let id = '';
  do {
    id = ID_ALPHABET[Number(n % 64n)] + id;
    n /= 64n;
  } while (n > 0n);
  return id;
}

/**
 * Finds the first Instagram link in `text`. Returns
 *   null                  no Instagram link
 *   { key }               something downloadable (see KEY_TYPES)
 *   { share: url }        an instagram.com/share/… link; pass it to resolveShareLink
 *   { unsupported: true } an Instagram link the bot can't download (profile, audio page, …)
 */
export function parseInstagramLink(text) {
  const match = text?.match(IG_URL);
  if (!match) return null;
  let url;
  try {
    url = new URL(/^https?:/i.test(match[0]) ? match[0] : `https://${match[0]}`);
  } catch {
    return { unsupported: true };
  }
  const seg = url.pathname.split('/').filter(Boolean);
  const kind = seg[0]?.toLowerCase();
  // story_media_id=<pk>_<user id> picks one item of a highlight
  const itemPk = url.searchParams.get('story_media_id')?.match(/^(\d+)(?:_\d+)?$/)?.[1];
  const highlight = (id) => ({ key: itemPk ? `h-${id}-${itemPk}` : `h-${id}` });

  // instagram.com/share/<code> or /share/<type>/<code>: only Instagram knows where these point
  if (kind === 'share') {
    const parts = seg.slice(1);
    if (parts.length >= 1 && parts.length <= 2 && parts.every((p) => CODE.test(p))) {
      return { share: `https://www.instagram.com/share/${parts.join('/')}/` };
    }
    return { unsupported: true };
  }

  // instagram.com/s/<base64 of "highlight:<id>">, what the app shares for a highlight
  if (kind === 's' && seg[1]) {
    const id = Buffer.from(seg[1], 'base64').toString('utf8').match(/^highlight:(\d+)$/)?.[1];
    return id ? highlight(id) : { unsupported: true };
  }

  if (kind === 'stories') {
    const [, user, id] = seg;
    if (user?.toLowerCase() === 'highlights') return DIGITS.test(id ?? '') ? highlight(id) : { unsupported: true };
    if (USERNAME.test(user ?? '') && DIGITS.test(id ?? '')) return { key: `s-${user}-${id}` };
    if (USERNAME.test(user ?? '') && !id) return { key: `u-${user}` };
    return { unsupported: true };
  }

  // instagram.com/reel/<code>, /reels/, /p/, /tv/, optionally after a username segment
  const at = POST_PATHS.has(kind) ? 0 : POST_PATHS.has(seg[1]?.toLowerCase()) ? 1 : -1;
  const code = at >= 0 ? seg[at + 1] : undefined;
  if (code && CODE.test(code) && code !== 'audio') return { key: `p-${code}` };

  return { unsupported: true };
}

/**
 * Follows an instagram.com/share/… link's redirects to the post or story it points
 * at and returns that item's key, or null if it doesn't lead anywhere downloadable.
 */
export async function resolveShareLink(url) {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const res = await fetch(current, {
      redirect: 'manual',
      headers: { 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(15_000),
    });
    await res.body?.cancel();
    const location = res.headers.get('location');
    if (!location) return null;
    current = new URL(location, current).href;
    const link = parseInstagramLink(current);
    if (link?.key) return link.key;
    if (!link?.share) return null; // e.g. redirected to the login page
  }
  return null;
}

/* COOKIES PAUSED: the Instagram login isn't used at all for now.
function cookieArgs() {
  if (process.env.IG_COOKIES_FILE) return ['--cookies', process.env.IG_COOKIES_FILE];
  if (process.env.IG_COOKIES_FROM_BROWSER) return ['--cookies-from-browser', process.env.IG_COOKIES_FROM_BROWSER];
  return [];
}
*/

/**
 * Downloads everything `key` points at into `dir`: one item for a reel or single
 * photo, several for a carousel, story set or highlight. Returns
 * { items: [{ file, kind: 'video' | 'photo', width, height, duration }], author, description, partial },
 * where `partial` means some items failed or the download timed out.
 */
export async function downloadMedia(key, dir) {
  const request = requestFor(key);
  if (!request) throw new Error(`Not a valid media key: ${key}`);

  // COOKIES PAUSED (November 2026): Instagram suspended the account behind the cookies,
  // so nothing uses the login. Stories and highlights can't download without it, so
  // they're refused; posts and reels download anonymously. To turn the login back on,
  // search the code for "COOKIES PAUSED" and restore each spot.
  if (request.story) throw Object.assign(new Error('Stories and highlights are paused'), { code: 'STORIES_PAUSED' });
  return runYtdlp(key, request, dir);

  /* COOKIES PAUSED: the routing with the login.
  // Stories and highlights need the login. Posts and reels go without it first:
  // as of November 2026, Instagram answers yt-dlp's logged-in post request with
  // HTTP 400, while the anonymous one works. The login is tried only when the
  // anonymous download fails, e.g. for a private account's post.
  if (request.story || !hasLogin()) return runYtdlp(key, request, dir, request.story);
  try {
    return await runYtdlp(key, request, dir, false);
  } catch (anonymousErr) {
    try {
      return await runYtdlp(key, request, dir, true);
    } catch (loginErr) {
      console.error(`[${key}] with the Instagram login:`, loginErr.stderr || loginErr.message);
      throw anonymousErr; // says why the post isn't public, which is the more useful message
    }
  }
  */
}

async function runYtdlp(key, request, dir /* COOKIES PAUSED: , withLogin */) {
  let stdout;
  let partial = false;
  try {
    ({ stdout } = await run(
      YTDLP,
      [
        '--no-progress',
        '--no-warnings',
        '--plugin-dirs', PLUGIN_DIR,
        // videos: best mp4 (merging separate video and audio); photos: the plugin's "photo" format
        '-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b/photo',
        '--merge-output-format', 'mp4',
        '-o', path.join(dir, '%(id)s.%(ext)s'),
        '--print', `after_move:%(.{${ITEM_FIELDS}})j`,
        ...request.args,
        // COOKIES PAUSED: ...(withLogin ? cookieArgs() : []),
        '--',
        request.url,
      ],
      { timeout: DOWNLOAD_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
    ));
  } catch (err) {
    // When one item of a carousel or story set fails, yt-dlp still downloads the rest
    // but exits non-zero; on a timeout it is killed partway. Either way, keep the items
    // it finished (each is printed only once it's complete).
    if (!err.stdout?.includes('{')) throw Object.assign(err, { source: 'yt-dlp' });
    console.warn(`[${key}] ${err.killed ? 'timed out' : 'some items failed'}:`, err.stderr);
    stdout = err.stdout;
    partial = true;
  }

  const items = stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));
  if (items.length === 0) {
    // e.g. the story expired, or the highlight no longer has that item
    throw Object.assign(new Error(`yt-dlp downloaded nothing for ${key}`), { code: 'NO_MEDIA' });
  }

  const first = items[0];
  return {
    username: first.channel,
    author: first.channel ? `@${first.channel}` : first.uploader,
    description: first.description,
    partial,
    items: items.map((item) => ({
      file: item.filepath,
      kind: PHOTO_EXT.test(item.ext) ? 'photo' : 'video',
      width: item.width,
      height: item.height,
      duration: item.duration,
    })),
  };
}
