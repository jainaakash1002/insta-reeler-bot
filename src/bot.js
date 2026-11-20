import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Bot, InlineKeyboard, InputFile, InputMediaBuilder } from 'grammy';
import { parseFacebookLink, resolveFacebookShareLink } from './facebook.js';
import { parseRedditLink, resolveRedditShareLink } from './reddit.js';
import { parseSnapchatLink, resolveSnapchatShareLink } from './snapchat.js';
import { parseXLink, resolveXShareLink } from './x.js';
import { dropRepeats, ensureH264, extractFrames, ffmpegMode } from './frames.js';
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

// After the computer sleeps or changes network, the open getUpdates request can sit on a
// dead connection until grammY's 500 s client timeout: the bot looks alive but ignores
// messages for minutes. getUpdates long-polls for 30 s, so drop it after GET_UPDATES_LIMIT_MS;
// grammY then retries on a fresh connection. (grammY's signal comes from its own
// AbortController polyfill, which AbortSignal.any rejects, hence the manual wiring.)
const GET_UPDATES_LIMIT_MS = 45_000;
bot.api.config.use((prev, method, payload, signal) => {
  if (method !== 'getUpdates') return prev(method, payload, signal);
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, GET_UPDATES_LIMIT_MS);
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort); // bot.stop() still cancels it at once
  return prev(method, payload, controller.signal).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  });
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
  for (const item of media.items) {
    // Facebook often serves VP9; Reddit's videos are usually H.264 already, so this only probes them
    if (siteOf(key) !== 'instagram' && item.kind === 'video') await ensureH264(item.file);
    item.size = (await fs.stat(item.file)).size;
  }
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

/*
 * A "working on it" message that looks alive: the moon in front of the text cycles
 * 🌑🌒🌓🌔🌕🌖🌗🌘 while the bot works, and Telegram's own "sending a video…" indicator shows at
 * the top of the chat. done() deletes the message; fail(text) turns it into the error.
 * Groups allow a bot about 20 messages (edits included) a minute, so the animation is slower
 * there. An edit still waiting for Telegram is never doubled up, and loader edits that fail
 * (rate limits, the message was deleted) are just skipped.
 */
const LOADER_FRAMES = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];
const ACTION_EVERY_MS = 4000; // a chat action shows for 5 s

async function startLoader(ctx, label, { replyTo, action = 'upload_video' } = {}) {
  const chatId = ctx.chat.id;
  const tickMs = ctx.chat.type === 'private' ? 1500 : 4000;
  let text = label;
  let frame = 0;
  let busy = false;
  let stopped = false;
  let lastAction = 0;
  const render = () => `${LOADER_FRAMES[frame % LOADER_FRAMES.length]} ${text}`;
  const showAction = () => {
    if (Date.now() - lastAction < ACTION_EVERY_MS) return;
    lastAction = Date.now();
    ctx.api.sendChatAction(chatId, action).catch(() => {});
  };

  const message = await ctx.api.sendMessage(
    chatId,
    render(),
    replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {},
  );
  showAction();
  const timer = setInterval(() => {
    showAction();
    if (busy || stopped) return;
    busy = true;
    frame++;
    ctx.api
      .editMessageText(chatId, message.message_id, render())
      .catch(() => {})
      .finally(() => {
        busy = false;
      });
  }, tickMs);
  timer.unref();

  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  return {
    /** Changes the text; it shows with the next frame. */
    set(label) {
      text = label;
    },
    async done() {
      stop();
      await ctx.api.deleteMessage(chatId, message.message_id).catch(() => {});
    },
    /** Replaces the loader with `errorText`, or sends it as a new message if that fails. */
    async fail(errorText) {
      stop();
      await ctx.api.editMessageText(chatId, message.message_id, errorText).catch(async (editErr) => {
        console.error(`couldn't edit the status message:`, editErr?.description ?? editErr);
        await ctx.api
          .sendMessage(chatId, errorText)
          .catch((sendErr) => console.error('Could not send the error either:', sendErr?.description ?? sendErr));
      });
    },
  };
}

const escapeHtml = (text) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const siteOf = (key) => requestFor(key)?.site ?? 'instagram';
const isFacebook = (key) => siteOf(key) === 'facebook';
const isReddit = (key) => siteOf(key) === 'reddit';
const isSnapchat = (key) => siteOf(key) === 'snapchat';
const isX = (key) => siteOf(key) === 'x';
const siteName = (key) => ({ facebook: 'Facebook', reddit: 'Reddit', snapchat: 'Snapchat', x: 'X' })[siteOf(key)] ?? 'Instagram';

/** A short caption: the account (linking to its profile) and a link to the post or story itself. */
function buildCaption(media, key) {
  if (isX(key)) {
    const user = /^\w{1,30}$/.test(media.username ?? '') ? media.username : null;
    const label = escapeHtml(media.author ? `${media.author} (@${user ?? '?'})` : `@${user}`);
    const account = user && `👤 <a href="https://x.com/${user}"><b>${label}</b></a>`;
    const post = `https://x.com/${user ?? 'i'}/status/${requestFor(key).xId}`;
    return [account, `🔗 <a href="${post}">Open on X</a>`].filter(Boolean).join('\n');
  }
  if (isSnapchat(key)) {
    const user = /^[a-z0-9][\w.-]{0,14}$/i.test(media.username ?? '') ? media.username : null;
    const label = escapeHtml(media.author ? `${media.author} (@${user ?? '?'})` : `@${user}`);
    const account = user && `👤 <a href="https://www.snapchat.com/@${user}"><b>${label}</b></a>`;
    const title = media.title && `✨ ${escapeHtml(media.title)}`;
    return [account, title, `🔗 <a href="${escapeHtml(requestFor(key).url)}">Open on Snapchat</a>`].filter(Boolean).join('\n');
  }
  if (isReddit(key)) {
    const user = /^[\w-]{1,30}$/.test(media.author ?? '') ? media.author : null;
    const account = user && `👤 <a href="https://www.reddit.com/user/${user}/"><b>u/${user}</b></a>`;
    const sub = /^r\/\w{1,30}$/.test(media.subreddit ?? '') ? media.subreddit : null;
    const where = sub && `<a href="https://www.reddit.com/${sub}/">${sub}</a>`;
    return [[account, where].filter(Boolean).join(' in '), `🔗 <a href="${escapeHtml(requestFor(key).url)}">Open on Reddit</a>`]
      .filter(Boolean)
      .join('\n');
  }
  if (isFacebook(key)) {
    // yt-dlp gives a Facebook page's display name and numeric id; facebook.com/<id> opens the page.
    const id = /^\d+$/.test(media.uploaderId ?? '') ? media.uploaderId : null;
    const name = media.author && `<b>${escapeHtml(media.author)}</b>`;
    const account = name && (id ? `👤 <a href="https://www.facebook.com/${id}">${name}</a>` : `👤 ${name}`);
    return [account, `🔗 <a href="${escapeHtml(requestFor(key).url)}">Open on Facebook</a>`].filter(Boolean).join('\n');
  }
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
  if (err?.code === 'SHARE_LINK' && err.site === 'facebook') {
    return "I couldn't find a video behind that Facebook link. Open it in a browser and send me the link of the video it shows.";
  }
  if (err?.code === 'SHARE_LINK' && err.site === 'reddit') {
    return "I couldn't open that Reddit share link. Open it in a browser and send me the reddit.com/r/…/comments/… link it lands on.";
  }
  if (err?.code === 'REDDIT_NEEDS_KEY') {
    return (
      'Reddit blocks downloads from this machine without an API key. The bot owner can add a free one: ' +
      'see “Reddit” in the README.'
    );
  }
  if (err?.code === 'REDDIT_KEY_INVALID') return 'Reddit rejected the bot’s API key. The bot owner should check REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET.';
  if (err?.code === 'EXTERNAL_LINK') {
    return `That Reddit post links to ${err.domain ?? 'another site'}. I can only download photos, GIFs and videos hosted on Reddit.`;
  }
  if (err?.code === 'X_GONE') return 'That X post doesn’t exist anymore, or its account is protected (private).';
  if (err?.code === 'X_HIDDEN') {
    return 'X hides that post from logged-out visitors (it’s marked as sensitive or age-restricted), so I can’t download it.';
  }
  if (err?.code === 'X_RATE_LIMIT') return 'X is limiting requests right now. Try again in a few minutes.';
  if (err?.code === 'NO_MEDIA' && isX(key)) return 'That X post has no photos, GIFs or videos.';
  if (err?.code === 'SHARE_LINK' && err.site === 'x') {
    return "I couldn't open that t.co link. Open it in a browser and send me the x.com link it lands on.";
  }
  if (err?.code === 'SNAP_GONE') {
    return 'That snap isn’t in their story anymore (stories disappear after 24 hours). Send their profile link for what’s there now.';
  }
  if (err?.code === 'SPOTLIGHT_HIDDEN') {
    return 'This Spotlight video is only available inside the Snapchat app (it doesn’t open on the web), so I can’t download it.';
  }
  if (err?.code === 'NO_STORY') {
    return 'That Snapchat account has no public story right now. Stories disappear after 24 hours.';
  }
  if (err?.code === 'NO_MEDIA' && isSnapchat(key)) return 'That Snapchat link has nothing to download (it may be removed or private).';
  if (err?.code === 'SHARE_LINK' && err.site === 'snapchat') {
    return "I couldn't open that Snapchat link. Open it in a browser and send me the snapchat.com link it lands on.";
  }
  if (err?.code === 'NO_MEDIA' && isReddit(key)) return 'That Reddit post has no photo, GIF or video (or it was deleted).';
  if (err?.code === 'SHARE_LINK') {
    return "I couldn't open that share link. Open it in a browser and send me the instagram.com link it lands on.";
  }
  if (err?.code === 'NO_MEDIA') {
    return story ? "That story isn't there anymore. Stories disappear after 24 hours." : 'That post has nothing to download.';
  }
  // Only blame Instagram (expired story, login, private post) for errors that came from yt-dlp.
  if (err?.source === 'ffmpeg') return "Couldn't grab screenshots from that video. Try again, or try another video.";
  if (err?.error_code && err?.description) return `Telegram didn't accept it: ${err.description}`; // GrammyError
  if (!['yt-dlp', 'facebook', 'reddit', 'snapchat', 'x'].includes(err?.source)) return 'Something went wrong on my side. Try again in a bit.';

  if (/no such option: --plugin-dirs/i.test(detail)) {
    return 'yt-dlp on the machine running the bot is too old. Update it: brew upgrade yt-dlp';
  }
  if (err.killed) return `${siteName(key)} took too long to respond. Try again in a bit.`;
  if (isX(key)) return "X didn't return this post. It may be deleted or private, or X changed something. Try again in a minute.";
  if (isSnapchat(key)) {
    return (
      "Snapchat didn't return this. It may be private or removed, or Snapchat changed its pages. " +
      'If it opens in a logged-out browser, try again in a minute.'
    );
  }
  if (isReddit(key)) {
    return (
      "Reddit didn't return this. The post may be removed, private or quarantined, " +
      'or Reddit is limiting requests. Try again in a minute.'
    );
  }
  if (isFacebook(key)) {
    return (
      "Facebook didn't return this. It may be private, deleted or only visible to logged-in " +
      'users, or Facebook changed something. If it opens in a logged-out browser, try again in a minute.'
    );
  }
  if (story) {
    return (
      "Couldn't get that story. It may have expired (stories last 24 hours), or the account is private " +
      "and the Instagram login the bot uses doesn't follow it. If no stories work, the login may have " +
      'expired: log in to Instagram again in that browser.'
    );
  }
  // Age-restricted or "sensitive" posts: Instagram says "This content isn't available to
  // everyone: It can't be seen by certain audiences" and only shows them to logged-in adults.
  if (/available to everyone|certain audiences/i.test(detail)) {
    return (
      'Instagram only shows this post to logged-in accounts (it’s age-restricted or marked sensitive), ' +
      'so I can’t download it.'
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
    '👋 Send me an Instagram, Facebook, Reddit, Snapchat or X link and I’ll send it back here.\n\n' +
      '✅ Works now\n' +
      '• Instagram reels and videos\n' +
      '• Instagram photo posts and carousels (every photo and video in them)\n' +
      '• Facebook videos, reels, posts and photos (public ones)\n' +
      '• Reddit videos, images, GIFs and galleries\n' +
      '• Snapchat Spotlight videos, public stories and highlights\n' +
      '• X (Twitter) posts: photos, videos and GIFs\n' +
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
    console.log(`Re-sent ${items.length} photo(s)/video(s) in chat ${chatId}`);
  } catch (err) {
    console.error('Re-sending media failed:', err?.description ?? err);
    await bot.api.sendMessage(chatId, `❌ ${describeError(err)}`).catch(() => {});
  }
}

bot.on('message:text', (ctx) => {
  const text = ctx.message.text;
  const link = parseInstagramLink(text) ?? parseFacebookLink(text) ?? parseRedditLink(text) ?? parseSnapchatLink(text) ?? parseXLink(text);
  if (!link) return; // plain text without a supported link: ignore it
  if (link.unsupported && link.site === 'x') {
    return ctx.reply('From X I can download posts with photos, videos or GIFs. Send a link to the post (Share → Copy link).');
  }
  if (link.unsupported && link.site === 'snapchat') {
    return ctx.reply(
      'From Snapchat I can download Spotlight videos, public stories and highlights. ' +
        'Send a Spotlight link, a profile link (for the current story) or a highlight link.',
    );
  }
  if (link.unsupported && link.site === 'reddit') {
    return ctx.reply('From Reddit I can download posts with videos, images, GIFs or galleries. Send a link to the post (Share → Copy link).');
  }
  if (link.unsupported && link.site === 'facebook') {
    return ctx.reply(
      'From Facebook I can download videos, reels, posts and photos. Send a link to one (in the app: Share → Copy link).',
    );
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
  let key = link.key;
  const loader = await startLoader(ctx, key ? `Downloading from ${siteName(key)}…` : 'Opening the link…', {
    replyTo: ctx.message.message_id,
  });

  try {
    const resolve = { facebook: resolveFacebookShareLink, reddit: resolveRedditShareLink, snapchat: resolveSnapchatShareLink, x: resolveXShareLink }[link.site] ?? resolveShareLink;
    key ??= await resolve(link.share).catch((err) => {
      console.error(`[${link.share}] share link:`, err);
      return null;
    });
    if (!key) throw Object.assign(new Error(`Share link led nowhere: ${link.share}`), { code: 'SHARE_LINK', site: link.site });
    if (needsLogin(key)) throw Object.assign(new Error('Stories and highlights are paused'), { code: 'STORIES_PAUSED' });
    // COOKIES PAUSED: if (needsLogin(key) && !hasLogin()) throw Object.assign(new Error('Login needed'), { code: 'NEEDS_LOGIN' });

    loader.set(`Downloading from ${siteName(key)}…`);
    const media = await getMedia(key);
    const count = media.items.length;
    loader.set(count > 1 ? `Sending ${count} items…` : `Sending the ${media.items[0]?.kind ?? 'item'}…`);
    const complete = await deliver(ctx, key, media);
    await loader.done();
    // Everything arrived, so the user's link message has done its job. After an error, or if
    // some items couldn't be sent, it stays so the user can see what they asked for.
    if (complete) await ctx.deleteMessage().catch(() => {});
    console.log(`[${key}] sent ${media.items.length} item(s) to chat ${ctx.chat.id}${complete ? '' : ' (incomplete)'}`);
  } catch (err) {
    console.error(`[${key ?? link.share}]`, err?.stderr || err);
    // The loader becomes the error (or the error is sent anew), so it never spins with no answer.
    await loader.fail(`❌ ${describeError(err, key)}`);
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
  const complete = tooBig.length === 0 && !media.partial && !media.hidden;

  // One reel or photo: caption and button on the same message, like Instagram shows it.
  if (single && sendable.length === 1 && !media.partial && !media.hidden) {
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
    notes.push(`⚠️ Some items couldn’t be downloaded (${siteName(key)} refused them or it took too long), so this isn’t all of it.`);
  }
  if (media.hidden) {
    notes.push(
      `⚠️ This post has ${items.length + media.hidden} items, but Facebook shows only ${items.length} ` +
        'to visitors who aren’t logged in, so the rest are missing.',
    );
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
  let loader;

  try {
    loader = await startLoader(ctx, count === 1 ? 'Taking a screenshot…' : `Taking ${count} screenshots…`, {
      replyTo,
      action: 'upload_photo',
    });
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
    loader.set(frames.length > 1 ? `Sending ${frames.length} screenshots…` : 'Sending the screenshot…');
    await sendAlbums(ctx, frames.map(({ file }) => ({ file, kind: 'photo' })), { caption, parse_mode: 'HTML' }, sendOptions);
    await loader.done(); // before the cleanup, which may delete the message the loader replies to
    if (cleanup) await applyButtonCleanup(ctx, cleanup);
    console.log(`[${key}] sent ${frames.length} screenshot(s) of item ${n}`);
  } catch (err) {
    console.error(`[${key}]`, err?.stderr || err);
    const text = `❌ ${describeError(err, key)}`;
    if (loader) await loader.fail(text);
    else await ctx.reply(text, replyOptions).catch(() => {});
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

const logStarted = (me, mode) =>
  console.log(
    `@${me.username} is running (${mode}). Open https://t.me/${me.username} and send it an Instagram, Facebook, Reddit, Snapchat or X link.` +
      (ALLOWED_USERS.size ? ` Allowed users: ${[...ALLOWED_USERS].join(', ')}` : ' (open to everyone)') +
      ` Stories and highlights are paused (search the code for COOKIES PAUSED). ${ffmpegMode}.`,
    // COOKIES PAUSED: (hasLogin() ? '' : ' Stories and highlights are off until Instagram cookies are set in .env.'),
  );

/*
 * Webhook mode (WEBHOOK_URL set, e.g. on Render's free plan): Telegram POSTs each update to
 * <WEBHOOK_URL>/telegram, which also wakes a host that sleeps when idle. Any other request
 * gets "ok" (health checks). Telegram is answered at once and the update is handled after:
 * downloads run in the background anyway, and an error answer would make Telegram send the
 * same update again. The secret header proves a request came from Telegram; it's derived
 * from the token, so there is nothing extra to configure.
 * Without WEBHOOK_URL the bot long-polls as before. Polling (npm start) removes the webhook,
 * so after running it locally, restart the hosted bot to set the webhook again.
 */
async function startWebhook(baseUrl) {
  const hookPath = '/telegram';
  const secret = createHash('sha256').update(`webhook:${BOT_TOKEN}`).digest('hex');
  await bot.init();
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== hookPath) {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
      return;
    }
    if (req.headers['x-telegram-bot-api-secret-token'] !== secret) {
      res.writeHead(401).end();
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy(); // updates are a few KB
    });
    req.on('end', () => {
      res.writeHead(200).end();
      let update;
      try {
        update = JSON.parse(body);
      } catch {
        return;
      }
      bot.handleUpdate(update).catch((err) => console.error('Bot error:', err.error ?? err));
    });
  });
  const port = Number(process.env.PORT) || 3000;
  await new Promise((resolve) => server.listen(port, resolve));
  await bot.api.setWebhook(`${baseUrl}${hookPath}`, { secret_token: secret });
  const stop = () => server.close(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  logStarted(bot.botInfo, `webhook, port ${port}`);
}

const WEBHOOK_URL = process.env.WEBHOOK_URL?.trim().replace(/\/+$/, '');
if (WEBHOOK_URL) {
  if (!/^https:\/\/[^\s/]+$/i.test(WEBHOOK_URL)) {
    console.error('WEBHOOK_URL must be the https:// address of the service, e.g. https://my-bot.onrender.com');
    process.exit(1);
  }
  await startWebhook(WEBHOOK_URL);
} else {
  process.once('SIGINT', () => bot.stop());
  process.once('SIGTERM', () => bot.stop());
  bot.start({ onStart: (me) => logStarted(me, 'polling') });
}
