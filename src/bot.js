import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Bot, InlineKeyboard, InputFile, InputMediaBuilder } from 'grammy';
import { extractFrames } from './frames.js';
import { downloadMedia, hasLogin, needsLogin, parseInstagramLink, requestFor, resolveShareLink } from './instagram.js';

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is missing. Copy .env.example to .env and paste the token from @BotFather.');
  process.exit(1);
}

const ALLOWED_USERS = new Set(
  (process.env.ALLOWED_USER_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .map(Number),
);
const SCREENSHOT_COUNT = Math.min(10, Math.max(1, Number(process.env.SCREENSHOT_COUNT) || 6));
const CACHE_DIR = path.join(os.tmpdir(), 'insta-reel-bot');
const CACHE_TTL_MS = 60 * 60 * 1000;
// Bot API limits for files a bot uploads
const UPLOAD_LIMIT = { video: 50 * 1024 * 1024, photo: 10 * 1024 * 1024 };
const CAPTION_TEXT_LIMIT = 850; // Telegram captions max out at 1024 chars; leave room for the header/link
const ALBUM_LIMIT = 10; // items per Telegram album (media group)
const CALLBACK_DATA_LIMIT = 64; // bytes
const MAX_BUTTONS = 100; // per inline keyboard

const LOGIN_HELP =
  'Stories and highlights only download with an Instagram login. ' +
  'Set IG_COOKIES_FROM_BROWSER=chrome (or your browser) in the bot’s .env file and restart it. See the README.';

const bot = new Bot(BOT_TOKEN);

// Telegram answers 429 when a bot sends too fast, e.g. several albums of stories in a
// row. Wait as long as it asks, a few times at most.
bot.api.config.use(async (prev, method, payload, signal) => {
  for (let attempt = 1; ; attempt++) {
    const res = await prev(method, payload, signal);
    const wait = res.parameters?.retry_after;
    if (res.ok || res.error_code !== 429 || !wait || attempt >= 3) return res;
    await new Promise((resolve) => setTimeout(resolve, wait * 1000));
  }
});

// ---------- download cache ----------

const inFlight = new Map();

/** Downloads what `key` points at once; repeat requests within CACHE_TTL_MS reuse the files on disk. */
function getMedia(key) {
  if (!inFlight.has(key)) {
    inFlight.set(key, loadOrDownload(key).finally(() => inFlight.delete(key)));
  }
  return inFlight.get(key);
}

async function loadOrDownload(key) {
  const dir = path.join(CACHE_DIR, key);
  const metaFile = path.join(dir, 'meta.json');

  try {
    const media = JSON.parse(await fs.readFile(metaFile, 'utf8'));
    await Promise.all(media.items.map((item) => fs.access(item.file)));
    const now = new Date();
    await fs.utimes(dir, now, now); // keep it from being pruned while in use
    return { ...media, dir };
  } catch {
    // not cached yet (or cache is broken): download fresh
  }

  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  const media = await downloadMedia(key, dir);
  for (const item of media.items) item.size = (await fs.stat(item.file)).size;
  await fs.writeFile(metaFile, JSON.stringify(media));
  return { ...media, dir };
}

async function pruneCache() {
  const entries = await fs.readdir(CACHE_DIR, { withFileTypes: true }).catch(() => []);
  const cutoff = Date.now() - CACHE_TTL_MS;
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !inFlight.has(entry.name))
      .map(async (entry) => {
        const dir = path.join(CACHE_DIR, entry.name);
        const { mtimeMs } = await fs.stat(dir);
        if (mtimeMs < cutoff) await fs.rm(dir, { recursive: true, force: true });
      }),
  );
}

// ---------- message helpers ----------

const escapeHtml = (text) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function buildCaption(media, key) {
  let text = (media.description ?? '').trim();
  if (text.length > CAPTION_TEXT_LIMIT) {
    // drop a dangling half of an emoji (surrogate pair) before adding the ellipsis
    text = `${text.slice(0, CAPTION_TEXT_LIMIT).replace(/[\uD800-\uDBFF]$/, '').trimEnd()}…`;
  }
  return [
    media.author && `👤 <b>${escapeHtml(media.author)}</b>`,
    text && escapeHtml(text),
    `🔗 <a href="${escapeHtml(requestFor(key).url)}">Open on Instagram</a>`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

const megabytes = (bytes) => `${Math.round(bytes / 1024 / 1024)} MB`;
const fitsTelegram = (item) => item.size <= UPLOAD_LIMIT[item.kind];

const videoOptions = (item) => ({
  supports_streaming: true,
  ...(item.width && { width: item.width }),
  ...(item.height && { height: item.height }),
  ...(item.duration && { duration: Math.round(item.duration) }),
});

/** Screenshot buttons for the given videos (items numbered from 1 as `n`), or undefined if none fit. */
function screenshotKeyboard(key, videos) {
  const buttons = videos
    .map((video) => ({ video, data: `ss:${video.n}:${key}` }))
    .filter(({ data }) => Buffer.byteLength(data) <= CALLBACK_DATA_LIMIT)
    .slice(0, MAX_BUTTONS);
  if (buttons.length === 0) return undefined;
  const keyboard = new InlineKeyboard();
  if (buttons.length === 1) return keyboard.text(`📸 Get ${SCREENSHOT_COUNT} screenshots`, buttons[0].data);
  buttons.forEach(({ video, data }, i) => {
    if (i > 0 && i % 4 === 0) keyboard.row();
    keyboard.text(`📸 #${video.n}`, data);
  });
  return keyboard;
}

/** Sends one photo or video as its own message. */
async function sendOne(ctx, item, extra = {}) {
  const file = new InputFile(item.file);
  if (item.kind === 'photo') return ctx.replyWithPhoto(file, extra);
  await ctx.replyWithChatAction('upload_video').catch(() => {});
  return ctx.replyWithVideo(file, { ...videoOptions(item), ...extra });
}

/**
 * Sends items as albums of up to 10. `captionOptions` (caption, parse_mode) go on the very
 * first item; `messageOptions` (e.g. reply_parameters) on every message.
 */
async function sendAlbums(ctx, items, captionOptions = {}, messageOptions = {}) {
  for (let i = 0; i < items.length; i += ALBUM_LIMIT) {
    const chunk = items.slice(i, i + ALBUM_LIMIT);
    const first = i === 0 ? captionOptions : {};
    if (chunk.length === 1) {
      await sendOne(ctx, chunk[0], { ...first, ...messageOptions }); // an album needs at least 2 items
      continue;
    }
    await ctx.replyWithMediaGroup(
      chunk.map((item, j) => {
        const options = j === 0 ? first : {};
        return item.kind === 'photo'
          ? InputMediaBuilder.photo(new InputFile(item.file), options)
          : InputMediaBuilder.video(new InputFile(item.file), { ...videoOptions(item), ...options });
      }),
      messageOptions,
    );
  }
}

function describeError(err, key) {
  const detail = `${err?.stderr ?? ''} ${err?.message ?? ''}`;
  const story = needsLogin(key);
  if (err?.code === 'ENOENT') return 'yt-dlp or ffmpeg is not installed on the machine running the bot.';
  if (/no such option: --plugin-dirs/i.test(detail)) {
    return 'yt-dlp on the machine running the bot is too old. Update it: brew upgrade yt-dlp';
  }
  if (err?.killed) return 'Instagram took too long to respond. Try again in a bit.';
  if (err?.code === 'NEEDS_LOGIN') return LOGIN_HELP;
  if (err?.code === 'SHARE_LINK') {
    return "I couldn't open that share link. Open it in a browser and send me the instagram.com link it lands on.";
  }
  if (err?.code === 'NO_MEDIA') {
    return story ? "That story isn't there anymore. Stories disappear after 24 hours." : 'That post has nothing to download.';
  }
  if (story) {
    return (
      "Couldn't get that story. It may have expired (stories last 24 hours), or the account is private " +
      "and the Instagram login the bot uses doesn't follow it. If no stories work, the login may have " +
      'expired: log in to Instagram again in that browser.'
    );
  }
  if (/login|rate.?limit|cookies|private|not available|restricted|\b40[13]\b/i.test(detail)) {
    return (
      "Instagram didn't return this post. It may be private or deleted, the link may be wrong, " +
      "or Instagram wants a login. If it opens fine in a logged-out browser, try again in a minute. " +
      'If public posts keep failing, set up Instagram cookies (see README).'
    );
  }
  return "Couldn't get that. Check the link and try again.";
}

// ---------- handlers ----------

bot.use(async (ctx, next) => {
  if (ALLOWED_USERS.size === 0 || ALLOWED_USERS.has(ctx.from?.id)) return next();
  if (ctx.callbackQuery) return ctx.answerCallbackQuery({ text: 'This bot is private.' });
  if (ctx.chat?.type === 'private') {
    return ctx.reply(`Sorry, this bot is private.\nYour Telegram user ID is ${ctx.from?.id}.`);
  }
});

bot.command(['start', 'help'], (ctx) =>
  ctx.reply(
    'Send me an Instagram link and I’ll send what’s in it back here:\n' +
      '• reels and video posts\n' +
      '• photo posts and carousels (all photos and videos)\n' +
      '• stories, a user’s current stories (instagram.com/stories/username) and highlights' +
      (hasLogin() ? '' : ' (needs an Instagram login set up in the bot’s .env)') +
      '\n\n' +
      `Tap “📸 Get ${SCREENSHOT_COUNT} screenshots” under a video to get frames from it.\n\n` +
      `Your Telegram user ID: ${ctx.from?.id}`,
  ),
);

bot.on('message:text', (ctx) => {
  const link = parseInstagramLink(ctx.message.text);
  if (!link) {
    return ctx.reply('Send me an Instagram link: a reel, post, story or highlight, like https://www.instagram.com/reel/ABC123xyz/');
  }
  if (link.unsupported) {
    return ctx.reply(
      "I can't download from that kind of Instagram link. Send a link to a reel, post, story or highlight " +
        '(in the app: Share → Copy link).',
    );
  }
  if (link.key && needsLogin(link.key) && !hasLogin()) return ctx.reply(LOGIN_HELP);
  // Not awaited, so the bot keeps answering other messages while this one downloads.
  sendMedia(ctx, link).catch((err) => console.error(`[${link.key ?? link.share}] sendMedia failed:`, err));
});

async function sendMedia(ctx, link) {
  const status = await ctx.reply('⏳ Downloading…', {
    reply_parameters: { message_id: ctx.message.message_id },
  });
  let key = link.key;

  try {
    key ??= await resolveShareLink(link.share).catch((err) => {
      console.error(`[${link.share}] share link:`, err);
      return null;
    });
    if (!key) throw Object.assign(new Error(`Share link led nowhere: ${link.share}`), { code: 'SHARE_LINK' });
    if (needsLogin(key) && !hasLogin()) throw Object.assign(new Error('Login needed'), { code: 'NEEDS_LOGIN' });

    const media = await getMedia(key);
    await deliver(ctx, key, media);
    await ctx.api.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
  } catch (err) {
    console.error(`[${key ?? link.share}]`, err?.stderr || err);
    await ctx.api.editMessageText(ctx.chat.id, status.message_id, `❌ ${describeError(err, key)}`).catch(() => {});
  }
}

/** Sends the downloaded items, then notes about skipped ones and screenshot buttons. */
async function deliver(ctx, key, media) {
  const items = media.items.map((item, i) => ({ ...item, n: i + 1 }));
  const sendable = items.filter(fitsTelegram);
  const tooBig = items.filter((item) => !fitsTelegram(item));
  const videos = items.filter((item) => item.kind === 'video');
  const keyboard = screenshotKeyboard(key, videos);
  const buttons = keyboard ? { reply_markup: keyboard } : {};
  const caption = buildCaption(media, key);
  const single = items.length === 1;

  // One reel or photo: caption and button on the same message, like Instagram shows it.
  if (single && sendable.length === 1) {
    await sendOne(ctx, sendable[0], { caption, parse_mode: 'HTML', ...buttons });
    return;
  }

  await sendAlbums(ctx, sendable, { caption, parse_mode: 'HTML' });

  const notes = tooBig.map(
    (item) =>
      `⚠️ ${single ? `This ${item.kind} is` : `Item ${item.n} is a ${item.kind} of`} ${megabytes(item.size)}, ` +
      `over Telegram’s ${megabytes(UPLOAD_LIMIT[item.kind])} limit for bots, so I can’t send it.`,
  );
  if (keyboard) {
    if (single) notes.push('I can still grab screenshots from it.');
    else if (videos.length === 1) notes.push(`Tap below for ${SCREENSHOT_COUNT} screenshots from the video (item ${videos[0].n}).`);
    else notes.push(`Tap an item number for ${SCREENSHOT_COUNT} screenshots from that video:`);
  }
  if (notes.length === 0) return;
  // If nothing could be sent, the caption still belongs in the chat.
  const text = [sendable.length ? '' : caption, ...notes].filter(Boolean).join('\n\n');
  await ctx.reply(text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...buttons });
}

bot.callbackQuery(/^ss:(\d+):([\w.-]+)$/, async (ctx) => {
  const n = Number(ctx.match[1]);
  const key = ctx.match[2];
  if (!requestFor(key)) return ctx.answerCallbackQuery();
  await ctx.answerCallbackQuery({ text: '📸 Grabbing screenshots…' });
  sendScreenshots(ctx, key, n).catch((err) => console.error(`[${key}] sendScreenshots failed:`, err));
});

// Buttons from older versions of the bot
bot.on('callback_query:data', (ctx) =>
  ctx.answerCallbackQuery({ text: 'This button is from an older version of the bot. Send the link again.' }),
);

async function sendScreenshots(ctx, key, n) {
  const replyTo = ctx.callbackQuery.message?.message_id;
  const replyOptions = replyTo ? { reply_parameters: { message_id: replyTo } } : {};
  let framesDir;

  try {
    await ctx.replyWithChatAction('upload_photo');
    const media = await getMedia(key); // re-downloads if the cache expired
    const video = media.items[n - 1];
    if (video?.kind !== 'video') throw Object.assign(new Error(`Item ${n} of ${key} is not a video`), { code: 'NO_MEDIA' });

    framesDir = await fs.mkdtemp(path.join(media.dir, 'frames-'));
    const frames = await extractFrames(video.file, framesDir, SCREENSHOT_COUNT, video.duration);
    const from = [media.author && `from ${media.author}`, media.items.length > 1 && `(item ${n})`].filter(Boolean);
    await sendAlbums(
      ctx,
      frames.map(({ file }) => ({ file, kind: 'photo' })),
      { caption: [`📸 ${frames.length} screenshots`, ...from].join(' ') },
      replyOptions,
    );
  } catch (err) {
    console.error(`[${key}]`, err?.stderr || err);
    await ctx.reply(`❌ ${describeError(err, key)}`, replyOptions).catch(() => {});
  } finally {
    if (framesDir) await fs.rm(framesDir, { recursive: true, force: true });
  }
}

bot.catch((err) => console.error('Bot error:', err.error ?? err));

// ---------- start ----------

await fs.mkdir(CACHE_DIR, { recursive: true });
await pruneCache();
setInterval(() => pruneCache().catch(console.error), 10 * 60 * 1000).unref();

try {
  await bot.api.setMyCommands([{ command: 'start', description: 'How to use this bot' }]);
} catch (err) {
  if (err?.error_code === 401 || err?.error_code === 404) {
    console.error('Telegram rejected BOT_TOKEN. Copy the token from @BotFather again into .env.');
    process.exit(1);
  }
  throw err;
}

process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());

bot.start({
  onStart: (me) =>
    console.log(
      `@${me.username} is running. Open https://t.me/${me.username} and send it an Instagram link.` +
        (ALLOWED_USERS.size ? ` Allowed users: ${[...ALLOWED_USERS].join(', ')}` : ' (open to everyone)') +
        (hasLogin() ? '' : ' Stories and highlights are off until Instagram cookies are set in .env.'),
    ),
});
