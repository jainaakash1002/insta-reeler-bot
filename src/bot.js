import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Bot, InlineKeyboard, InputFile, InputMediaBuilder } from 'grammy';
import { dropRepeats, extractFrames } from './frames.js';
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
const ALBUM_LIMIT = 10; // items per Telegram album (media group)
const CALLBACK_DATA_LIMIT = 64; // bytes
const MAX_BUTTONS = 100; // per inline keyboard

const LOGIN_HELP =
  'Stories and highlights only download with an Instagram login. ' +
  'Set IG_COOKIES_FROM_BROWSER=chrome (or your browser) in the bot’s .env file and restart it. See the README.';

// COOKIES PAUSED: sent for story and highlight links while the Instagram login is turned off
const STORIES_PAUSED =
  '⏸ Stories and highlights are turned off for now. Reels, posts and carousels still work, so send one of those.';

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

/** A short caption: the account (linking to its profile) and a link to the post or story itself. */
function buildCaption(media, key) {
  // `username` is new; older cached downloads only have `author` ("@name" or a full name).
  const username = media.username ?? media.author?.match(/^@(\w[\w.]*)$/)?.[1];
  const account = username
    ? `👤 <a href="https://www.instagram.com/${username}/"><b>@${escapeHtml(username)}</b></a>`
    : media.author && `👤 <b>${escapeHtml(media.author)}</b>`;
  return [account, `🔗 <a href="${escapeHtml(requestFor(key).url)}">Open on Instagram</a>`].filter(Boolean).join('\n');
}

const megabytes = (bytes) => `${Math.round(bytes / 1024 / 1024)} MB`;
const fitsTelegram = (item) => item.size <= UPLOAD_LIMIT[item.kind];

const videoOptions = (item) => ({
  supports_streaming: true,
  ...(item.width && { width: item.width }),
  ...(item.height && { height: item.height }),
  ...(item.duration && { duration: Math.round(item.duration) }),
});

/*
 * Screenshot buttons carry `s1:<n>:<key>` (one frame from the middle of video n) or
 * `ss:<n>:<key>` (SCREENSHOT_COUNT frames spread across it).
 */
const SCREENSHOT_DATA = /^s([s1]):(\d+):([\w.-]+)$/;

/** Two screenshot buttons (1 / all) per video, numbered from 1 as `n`; undefined if none fit. */
function screenshotKeyboard(key, videos) {
  const rows = videos
    .map((video) => ({ video, one: `s1:${video.n}:${key}`, all: `ss:${video.n}:${key}` }))
    .filter(({ all }) => Buffer.byteLength(all) <= CALLBACK_DATA_LIMIT)
    .slice(0, MAX_BUTTONS / 2);
  if (rows.length === 0) return undefined;
  // The "1 screenshot" button is only for stories and highlights; reels and posts get "all" only.
  const offerOne = needsLogin(key);
  const keyboard = new InlineKeyboard();
  rows.forEach(({ video, one, all }, i) => {
    if (i > 0) keyboard.row(); // between rows only: a trailing empty row isn't valid
    const label = rows.length === 1 ? '📸' : `📸 #${video.n}:`;
    if (offerOne) keyboard.text(`${label} 1 screenshot`, one).text(`${label} all ${SCREENSHOT_COUNT}`, all);
    else keyboard.text(rows.length === 1 ? `📸 Get ${SCREENSHOT_COUNT} screenshots` : `${label} ${SCREENSHOT_COUNT} screenshots`, all);
  });
  return keyboard;
}

/**
 * Plans removing video n's screenshot buttons from the message they were on (once the user
 * is done with that video). A message that was only there for those buttons gets deleted;
 * a video keeps its message and just loses the buttons.
 */
function planButtonCleanup(message, n, key, deleteWhole) {
  if (deleteWhole) return { deleteMessage: true }; // "1 screenshot": the whole message goes
  const rows = message?.reply_markup?.inline_keyboard;
  if (!rows) return null;
  const isThisVideo = (button) => {
    const match = button.callback_data?.match(SCREENSHOT_DATA);
    return match && Number(match[2]) === n && match[3] === key;
  };
  const kept = rows.map((row) => row.filter((button) => !isThisVideo(button))).filter((row) => row.length);
  // A text message that was only there for buttons goes once it has none; a video stays.
  return { kept, deleteMessage: kept.length === 0 && message.text !== undefined };
}

async function applyButtonCleanup(ctx, plan) {
  if (plan.deleteMessage) return ctx.deleteMessage().catch(() => {});
  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: plan.kept } }).catch(() => {});
}

/** Sends one photo or video as its own message. */
async function sendOne(ctx, item, extra = {}) {
  const file = new InputFile(item.file);
  if (item.kind === 'photo') return ctx.replyWithPhoto(file, extra);
  await ctx.replyWithChatAction('upload_video').catch(() => {});
  return ctx.replyWithVideo(file, { ...videoOptions(item), ...extra });
}

/**
 * Sends items as albums of up to 10. `captionOptions` (caption, parse_mode) go on the first
 * item of every album; `messageOptions` (e.g. reply_parameters) on every message.
 */
async function sendAlbums(ctx, items, captionOptions = {}, messageOptions = {}) {
  for (let i = 0; i < items.length; i += ALBUM_LIMIT) {
    const chunk = items.slice(i, i + ALBUM_LIMIT);
    const first = captionOptions; // every album gets the caption, not just the first
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
  // ENOENT from starting a program (not from a missing file) means the tool isn't installed
  if (err?.code === 'ENOENT' && err?.syscall?.startsWith('spawn')) {
    return 'yt-dlp or ffmpeg is not installed on the machine running the bot.';
  }
  if (err?.code === 'NEEDS_LOGIN') return LOGIN_HELP;
  if (err?.code === 'STORIES_PAUSED') return STORIES_PAUSED; // COOKIES PAUSED
  if (err?.code === 'SHARE_LINK') {
    return "I couldn't open that share link. Open it in a browser and send me the instagram.com link it lands on.";
  }
  if (err?.code === 'NO_MEDIA') {
    return story ? "That story isn't there anymore. Stories disappear after 24 hours." : 'That post has nothing to download.';
  }
  // Only blame Instagram (expired story, login, private post) for errors that came from yt-dlp.
  if (err?.source === 'ffmpeg') return "Couldn't grab screenshots from that video. Try again, or try another video.";
  if (err?.error_code && err?.description) return `Telegram didn't accept it: ${err.description}`; // GrammyError
  if (err?.source !== 'yt-dlp') return 'Something went wrong on my side. Try again in a bit.';

  if (/no such option: --plugin-dirs/i.test(detail)) {
    return 'yt-dlp on the machine running the bot is too old. Update it: brew upgrade yt-dlp';
  }
  if (err.killed) return 'Instagram took too long to respond. Try again in a bit.';
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
      "or Instagram wants a login. If it opens fine in a logged-out browser, try again in a minute."
      // COOKIES PAUSED: + ' If public posts keep failing, set up Instagram cookies (see README).'
    );
  }
  return "Couldn't get that. Check the link and try again.";
}

// ---------- handlers ----------

bot.use(async (ctx, next) => {
  if (ALLOWED_USERS.size === 0 || ALLOWED_USERS.has(ctx.from?.id)) return next();
  if (ctx.callbackQuery) return ctx.answerCallbackQuery({ text: 'This bot is private.' }).catch(() => {});
  if (ctx.chat?.type === 'private') {
    return ctx.reply(`Sorry, this bot is private.\nYour Telegram user ID is ${ctx.from?.id}.`);
  }
});

bot.command(['start', 'help'], (ctx) =>
  ctx.reply(
    '👋 Send me an Instagram link and I’ll send it back here.\n\n' +
      '✅ Works now\n' +
      '• Reels and videos\n' +
      '• Photo posts and carousels (every photo and video in them)\n' +
      `• Screenshots: tap “📸 Get ${SCREENSHOT_COUNT} screenshots” under a video\n` +
      '• Send or forward me a photo or video and I’ll send it back without its caption\n\n' +
      // COOKIES PAUSED: when stories are back, move Stories and Highlights up to "Works now",
      // drop this section, and mention the "📸 1 screenshot" button that story videos get.
      '⏸ Not working right now\n' +
      '• Stories\n' +
      '• Highlights\n\n' +
      `Your Telegram user ID: ${ctx.from?.id}`,
  ),
);

// Photos and videos sent or forwarded to the bot come back without captions or "Forwarded
// from" headers. Several sent together (e.g. 3 forwarded at once) are collected for a moment
// and returned as albums of up to 10, then the originals are deleted. Telegram reuses the
// files by id; nothing is re-uploaded.
const COLLECT_MS = 1500; // how long to wait for more photos/videos from the same chat
const pendingMedia = new Map(); // chat id -> { items, timer }

bot.on(['message:photo', 'message:video'], (ctx) => {
  const { photo, video, message_id: order } = ctx.message;
  const item = video ? { kind: 'video', file: video.file_id, order } : { kind: 'photo', file: photo.at(-1).file_id, order };
  const chatId = ctx.chat.id;
  const pending = pendingMedia.get(chatId) ?? { items: [] };
  pending.items.push(item);
  clearTimeout(pending.timer);
  pending.timer = setTimeout(() => {
    pendingMedia.delete(chatId);
    resendMedia(chatId, pending.items).catch((err) => console.error('Re-sending media failed:', err));
  }, COLLECT_MS);
  pendingMedia.set(chatId, pending);
});

async function resendMedia(chatId, items) {
  items.sort((a, b) => a.order - b.order); // the order they were sent in
  try {
    for (let i = 0; i < items.length; i += ALBUM_LIMIT) {
      const chunk = items.slice(i, i + ALBUM_LIMIT);
      if (chunk.length === 1) {
        const [{ kind, file }] = chunk;
        if (kind === 'video') await bot.api.sendVideo(chatId, file, { supports_streaming: true });
        else await bot.api.sendPhoto(chatId, file);
        continue;
      }
      await bot.api.sendMediaGroup(
        chatId,
        chunk.map(({ kind, file }) =>
          kind === 'video' ? InputMediaBuilder.video(file, { supports_streaming: true }) : InputMediaBuilder.photo(file),
        ),
      );
    }
    // All copies are in the chat: remove the originals the user sent or forwarded.
    // (Only after full success; if sending failed above, they stay.)
    await bot.api.deleteMessages(chatId, items.map((item) => item.order)).catch(() => {});
  } catch (err) {
    console.error('Re-sending media failed:', err?.description ?? err);
    await bot.api.sendMessage(chatId, `❌ ${describeError(err)}`).catch(() => {});
  }
}

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
  if (link.key && needsLogin(link.key)) return ctx.reply(STORIES_PAUSED);
  // COOKIES PAUSED: if (link.key && needsLogin(link.key) && !hasLogin()) return ctx.reply(LOGIN_HELP);
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
    if (needsLogin(key)) throw Object.assign(new Error('Stories and highlights are paused'), { code: 'STORIES_PAUSED' });
    // COOKIES PAUSED: if (needsLogin(key) && !hasLogin()) throw Object.assign(new Error('Login needed'), { code: 'NEEDS_LOGIN' });

    const media = await getMedia(key);
    const complete = await deliver(ctx, key, media);
    await ctx.api.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
    // Everything arrived, so the user's link message has done its job. After an error, or if
    // some items couldn't be sent, it stays so the user can see what they asked for.
    if (complete) await ctx.deleteMessage().catch(() => {});
  } catch (err) {
    console.error(`[${key ?? link.share}]`, err?.stderr || err);
    await ctx.api.editMessageText(ctx.chat.id, status.message_id, `❌ ${describeError(err, key)}`).catch(() => {});
  }
}

/**
 * Sends the downloaded items, then notes about skipped ones and screenshot buttons.
 * Returns true if every item was sent.
 */
async function deliver(ctx, key, media) {
  const items = media.items.map((item, i) => ({ ...item, n: i + 1 }));
  const sendable = items.filter(fitsTelegram);
  const tooBig = items.filter((item) => !fitsTelegram(item));
  const videos = items.filter((item) => item.kind === 'video');
  const keyboard = screenshotKeyboard(key, videos);
  const buttons = keyboard ? { reply_markup: keyboard } : {};
  const caption = buildCaption(media, key);
  const single = items.length === 1;
  const complete = tooBig.length === 0 && !media.partial;

  // One reel or photo: caption and button on the same message, like Instagram shows it.
  if (single && sendable.length === 1 && !media.partial) {
    await sendOne(ctx, sendable[0], { caption, parse_mode: 'HTML', ...buttons });
    return complete;
  }

  await sendAlbums(ctx, sendable, { caption, parse_mode: 'HTML' });

  const notes = tooBig.map(
    (item) =>
      `⚠️ ${single ? `This ${item.kind} is` : `Item ${item.n} is a ${item.kind} of`} ${megabytes(item.size)}, ` +
      `over Telegram’s ${megabytes(UPLOAD_LIMIT[item.kind])} limit for bots, so I can’t send it.`,
  );
  if (media.partial) {
    notes.push('⚠️ Some items couldn’t be downloaded (Instagram refused them or it took too long), so this isn’t all of it.');
  }
  if (keyboard) {
    if (single && !sendable.length) notes.push('I can still grab screenshots from it.');
    else if (single) notes.push('Screenshots from the video:');
    else if (videos.length === 1) notes.push(`Screenshots from the video (item ${videos[0].n}):`);
    else notes.push('Screenshots from a video (by item number):');
  }
  if (notes.length === 0) return complete;
  // If nothing could be sent, the caption still belongs in the chat.
  const text = [sendable.length ? '' : caption, ...notes].filter(Boolean).join('\n\n');
  await ctx.reply(text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...buttons });
  return complete;
}

bot.callbackQuery(SCREENSHOT_DATA, async (ctx) => {
  const count = ctx.match[1] === '1' ? 1 : SCREENSHOT_COUNT;
  const n = Number(ctx.match[2]);
  const key = ctx.match[3];
  if (!requestFor(key)) return ctx.answerCallbackQuery().catch(() => {});
  // A tap that waited while the bot was restarting can't be answered any more (Telegram allows
  // ~15 s); that's only the little toast, so still send the screenshots.
  await ctx.answerCallbackQuery({ text: count === 1 ? '📸 Grabbing a screenshot…' : '📸 Grabbing screenshots…' }).catch(() => {});
  sendScreenshots(ctx, key, n, count).catch((err) => console.error(`[${key}] sendScreenshots failed:`, err));
});

// Buttons from older versions of the bot
bot.on('callback_query:data', (ctx) =>
  ctx.answerCallbackQuery({ text: 'This button is from an older version of the bot. Send the link again.' }).catch(() => {}),
);

/** Sends `count` screenshots of video n (1 = one frame from the middle), minus repeated frames. */
async function sendScreenshots(ctx, key, n, count) {
  const replyTo = ctx.callbackQuery.message?.message_id;
  const replyOptions = replyTo ? { reply_parameters: { message_id: replyTo } } : {};
  let framesDir;

  try {
    await ctx.replyWithChatAction('upload_photo');
    const media = await getMedia(key); // re-downloads if the cache expired
    const video = media.items[n - 1];
    if (video?.kind !== 'video') throw Object.assign(new Error(`Item ${n} of ${key} is not a video`), { code: 'NO_MEDIA' });

    framesDir = await fs.mkdtemp(path.join(media.dir, 'frames-'));
    const grabbed = await extractFrames(video.file, framesDir, count, video.duration);
    const frames = await dropRepeats(grabbed);

    // Same short caption as the post itself: the account and a link to the content.
    const caption = buildCaption(media, key);

    // After any screenshot request the video's buttons go; after "1 screenshot" the whole message.
    const cleanup = planButtonCleanup(ctx.callbackQuery.message, n, key, count === 1);
    // Don't reply to a message that's about to be deleted (Telegram would show "Deleted message").
    const sendOptions = cleanup?.deleteMessage ? {} : replyOptions;
    await sendAlbums(ctx, frames.map(({ file }) => ({ file, kind: 'photo' })), { caption, parse_mode: 'HTML' }, sendOptions);
    if (cleanup) await applyButtonCleanup(ctx, cleanup);
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
        ' Stories and highlights are paused (search the code for COOKIES PAUSED).',
      // COOKIES PAUSED: (hasLogin() ? '' : ' Stories and highlights are off until Instagram cookies are set in .env.'),
    ),
});
