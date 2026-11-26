import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Bot, InlineKeyboard, InputFile, InputMediaBuilder } from 'grammy';
import { parseFacebookLink, resolveFacebookShareLink } from './facebook.js';
import { parseRedditLink, resolveRedditShareLink } from './reddit.js';
import { parseSnapchatLink, resolveSnapchatShareLink } from './snapchat.js';
import { parseThreadsLink, resolveThreadsShareLink } from './threads.js';
import { parseXLink, resolveXShareLink } from './x.js';
import { cutClip, dropRepeats, ensureH264, extractFrames, ffmpegMode, grabFrameAt, makeSticker, toJpeg, videoDuration } from './frames.js';
import { buildPdf, embeddable, jpegInfo } from './pdf.js';
import { downloadMedia, hasLogin, needsLogin, parseInstagramLink, requestFor, resolveShareLink } from './instagram.js';

// ---------- config and access ----------

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is missing. Copy .env.example to .env and paste the token from @BotFather.');
  process.exit(1);
}

const idSet = (value) =>
  new Set(
    (value ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .map(Number),
  );
const ALLOWED_USERS = idSet(process.env.ALLOWED_USER_IDS);
// The owner(s): OWNER_USER_IDS (REDDIT_USER_IDS is its old name, still read). Only they may
// download Reddit links (they go through the owner's Reddit login) and use /chatid, and their
// downloads aren't copied to ARCHIVE_CHAT_ID. Empty: everyone who may use the bot counts as owner.
const OWNER_USERS = idSet(process.env.OWNER_USER_IDS ?? process.env.REDDIT_USER_IDS);
const isOwner = (userId) => OWNER_USERS.size === 0 || OWNER_USERS.has(userId);
// Optional: a chat (e.g. the owner's private group) that gets a copy of what other users download.
const ARCHIVE_CHAT_ID = process.env.ARCHIVE_CHAT_ID?.trim() || '';
// In a group with topics, the topic the copies go to (/chatid inside the topic shows its id).
// Unset: the group's General topic.
const ARCHIVE_TOPIC_ID = Number(process.env.ARCHIVE_TOPIC_ID) || undefined;
// In a group with topics, messages sent with bot.api/ctx.api (not ctx.reply*, which does this
// itself) need the topic's id, or they land in General.
const topicOf = (msg) => (msg?.is_topic_message ? { message_thread_id: msg.message_thread_id } : {});
const mayUseReddit = isOwner;
const OWNER_ONLY = 'This command is only for the bot’s owner.';
const REDDIT_OWNER_ONLY = 'Reddit downloads are only available to the bot’s owner.';
// Screenshot buttons can be limited the same way: SCREENSHOT_USER_IDS, or OWNER_USER_IDS when
// it isn't set ("all" or both empty: everyone). Others get no buttons, and a tap on someone else's is refused.
const screenshotSetting = process.env.SCREENSHOT_USER_IDS?.trim().toLowerCase();
const SCREENSHOT_USERS = screenshotSetting === 'all' ? new Set() : screenshotSetting ? idSet(screenshotSetting) : OWNER_USERS;
const mayScreenshot = (userId) => SCREENSHOT_USERS.size === 0 || SCREENSHOT_USERS.has(userId);
const SCREENSHOTS_OWNER_ONLY = 'Screenshots are only for the bot’s owner.';
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
  const topic = topicOf(ctx.msg);
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
    ctx.api.sendChatAction(chatId, action, topic).catch(() => {});
  };

  const message = await ctx.api.sendMessage(
    chatId,
    render(),
    { ...topic, ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}) },
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
          .sendMessage(chatId, errorText, topic)
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
const isThreads = (key) => siteOf(key) === 'threads';
const siteName = (key) =>
  ({ facebook: 'Facebook', reddit: 'Reddit', snapchat: 'Snapchat', x: 'X', threads: 'Threads' })[siteOf(key)] ?? 'Instagram';

/** A short caption: the account (linking to its profile) and a link to the post or story itself. */
function buildCaption(media, key) {
  if (isThreads(key)) {
    const user = /^[\w.]{1,30}$/.test(media.username ?? '') ? media.username : null;
    const label = escapeHtml(media.author ? `${media.author} (@${user ?? '?'})` : `@${user}`);
    const account = user && `👤 <a href="https://www.threads.com/@${user}"><b>${label}</b></a>`;
    return [account, `🔗 <a href="${escapeHtml(requestFor(key).url)}">Open on Threads</a>`].filter(Boolean).join('\n');
  }
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
 * `ss:<n>:<key>` (SCREENSHOT_COUNT frames spread across it). Every keyboard also gets a
 * "✖️ Cancel" button (`sx`) that removes the buttons without taking screenshots.
 */
const SCREENSHOT_DATA = /^s([s1]):(\d+):([\w.-]+)$/;
const DISMISS_DATA = 'sx';

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
  // One video: Cancel sits next to its button(s). Several: Cancel gets its own last row.
  if (rows.length > 1) keyboard.row();
  keyboard.text('✖️ Cancel', DISMISS_DATA);
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
  let kept = rows.map((row) => row.filter((button) => !isThisVideo(button))).filter((row) => row.length);
  // Only "Cancel" left: no screenshots to offer any more, so it goes too.
  if (kept.every((row) => row.every((button) => button.callback_data === DISMISS_DATA))) kept = [];
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
async function sendAlbums(ctx, items, captionOptions = {}, messageOptions = {}, key = undefined) {
  const ids = [];
  for (let i = 0; i < items.length; i += ALBUM_LIMIT) {
    const chunk = items.slice(i, i + ALBUM_LIMIT);
    const first = captionOptions; // every album gets the caption, not just the first
    if (chunk.length === 1) {
      const message = await sendOne(ctx, chunk[0], { ...first, ...messageOptions }); // an album needs at least 2 items
      ids.push(message.message_id);
      if (key) rememberPost(message, key);
      continue;
    }
    const messages = await ctx.replyWithMediaGroup(
      chunk.map((item, j) => {
        const options = j === 0 ? first : {};
        return item.kind === 'photo'
          ? InputMediaBuilder.photo(new InputFile(item.file), options)
          : InputMediaBuilder.video(new InputFile(item.file), { ...videoOptions(item), ...options });
      }),
      messageOptions,
    );
    ids.push(...messages.map((m) => m.message_id));
    if (key) messages.forEach((message) => rememberPost(message, key));
    rememberAlbum(messages); // so /pdf on any item gets the whole album
  }
  return ids;
}

// ---------- error messages ----------

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
  if (err?.code === 'REDDIT_LOGIN_EXPIRED') {
    return 'The bot’s Reddit login has expired, so Reddit refused this. The bot owner needs to export fresh Reddit cookies.';
  }
  if (err?.code === 'REDDIT_NEEDS_KEY') {
    return (
      'Reddit blocks downloads from this machine unless the bot is logged in. ' +
      'The bot owner can set REDDIT_COOKIES_FILE: see “Reddit” in the README.'
    );
  }
  if (err?.code === 'REDDIT_KEY_INVALID') return 'Reddit rejected the bot’s API key. The bot owner should check REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET.';
  if (err?.code === 'EXTERNAL_LINK') {
    return `That Reddit post links to ${err.domain ?? 'another site'}. I can only download photos, GIFs and videos hosted on Reddit.`;
  }
  if (err?.code === 'THREADS_GONE') return 'That Threads post doesn’t exist anymore, or its account is private.';
  if (err?.code === 'THREADS_RATE_LIMIT') return 'Threads is limiting requests right now. Try again in a few minutes.';
  if (err?.code === 'THREADS_CHANGED') return 'Threads changed how its website loads posts, so I can’t read them until the bot is updated.';
  if (err?.code === 'NO_MEDIA' && isThreads(key)) return 'That Threads post has no photos or videos.';
  if (err?.code === 'SHARE_LINK' && err.site === 'threads') {
    return "I couldn't open that Threads share link. Open it in a browser and send me the threads.com link it lands on.";
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
  if (!['yt-dlp', 'facebook', 'reddit', 'snapchat', 'x', 'threads'].includes(err?.source)) return 'Something went wrong on my side. Try again in a bit.';

  if (/no such option: --plugin-dirs/i.test(detail)) {
    return 'yt-dlp on the machine running the bot is too old. Update it: brew upgrade yt-dlp';
  }
  if (err.killed) return `${siteName(key)} took too long to respond. Try again in a bit.`;
  if (isThreads(key)) return "Threads didn't return this post. It may be deleted or private. Try again in a minute.";
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

/** The /start and /help text: per site, what works and what doesn't. HTML, static apart from the numbers. */
function helpText(userId) {
  const reddit = mayUseReddit(userId)
    ? ['👽 <b>Reddit</b>', '✅ Videos (with sound), images, GIFs, galleries', '❌ Text posts, links to other sites (YouTube, …)']
    : ['👽 <b>Reddit</b>', '🔒 Only for the bot’s owner'];
  return [
    '👋 Send me a link and I’ll send the photos and videos back here.',
    '',
    '📸 <b>Instagram</b>',
    '✅ Reels, videos, photo posts, carousels',
    // COOKIES PAUSED: when stories are back, move them to the ✅ line and mention the "📸 1 screenshot" button.
    '⏸ Stories and highlights (paused for now)',
    '❌ Profiles, audio pages, private accounts',
    '',
    '📘 <b>Facebook</b>',
    '✅ Public videos, reels, posts, photos',
    '❌ Private posts, groups, profiles',
    '',
    '👻 <b>Snapchat</b>',
    '✅ Spotlight videos, public stories, story snaps, highlights',
    '❌ Spotlights that only open in the app, private snaps, friends’ stories',
    '',
    '✖️ <b>X (Twitter)</b>',
    '✅ Photos, videos and GIFs from public posts',
    '❌ Protected accounts, sensitive posts',
    '',
    '🧵 <b>Threads</b>',
    '✅ Photos, videos and carousels from public posts',
    '❌ Private accounts, profiles, text-only posts',
    '',
    ...reddit,
    '',
    '🛠 <b>Extras</b>',
    ...(mayScreenshot(userId)
      ? [`• “📸 Get ${SCREENSHOT_COUNT} screenshots” button under every video`, '• ✂️ Reply to a video with /clip 0:05-0:15 (or /c) to get just that part']
      : []),
    '• Send or forward me a photo or video: it comes back without caption or “Forwarded from”',
    '• 🖼 Reply to a video with /frame (or /f) for screenshots across it, or /frame 0:12 for the picture at that exact moment (several times work too; add “file” for full quality)',
    '• 📎 Reply to a photo, video or album I sent with /file to get the originals as files (full quality)',
    '• 📄 Reply to a photo or album with /pdf to get it as one PDF (A4 pages), or send an album with /pdf as its caption',
    '• 🎨 Reply to a photo with /sticker (or /sticker 😂) to make it a sticker, then ➕ to add it to your own pack',
    '',
    '👥 In a group, make me an admin so I can see the links people send.',
    '',
    '⚠️ Videos up to 50 MB, photos up to 10 MB (Telegram’s limit for bots).' +
      (process.env.WEBHOOK_URL ? ' After a quiet spell, the first reply can take up to a minute while I wake up.' : ''),
    '',
    `Your Telegram user ID: <code>${Number(userId) || '?'}</code>`,
  ].join('\n');
}

bot.command(['start', 'help'], (ctx) => ctx.reply(helpText(ctx.from?.id), { parse_mode: 'HTML' }));

// /chatid: the current chat's id, e.g. to set up a group for the bot. Owner only (OWNER_USER_IDS).
bot.command('chatid', (ctx) => {
  if (!isOwner(ctx.from?.id)) return ctx.reply(OWNER_ONLY, { reply_parameters: { message_id: ctx.msg.message_id } });
  const topic = topicOf(ctx.msg).message_thread_id;
  return ctx.reply(
    `This chat’s ID: <code>${ctx.chat.id}</code> (${escapeHtml(ctx.chat.type)})` +
      (topic ? `\nThis topic’s ID: <code>${topic}</code>` : ''),
    { parse_mode: 'HTML' },
  );
});

// ---------- /clip ----------
// Reply to a video with "/clip 0:05-0:15" to get just that part, cut to the frame. Same
// access as screenshots (SCREENSHOT_USER_IDS). The video comes from Telegram (up to 20 MB, the
// Bot API's download limit), or, for a bigger video the bot sent, from the download cache
// (found through its screenshot button or caption link).
const CLIP_MAX_SECONDS = 60;
const TELEGRAM_DOWNLOAD_LIMIT = 20 * 1024 * 1024;
const CLIP_USAGE =
  'Reply to a video with <code>/clip 0:05-0:15</code> to get that part of it.\n' +
  `Times can be <code>5-15</code>, <code>1:05-1:20</code> or <code>1:02:03-1:02:30</code>. At most ${CLIP_MAX_SECONDS} seconds.`;
const TIME = String.raw`(\d{1,2}(?::\d{1,2}){0,2}(?:\.\d+)?)`;
const CLIP_RANGE = new RegExp(String.raw`^${TIME}\s*(?:-|–|—|to|\s)\s*${TIME}$`, 'i');

/** "1:02:03.5" → 3723.5 seconds; NaN if a minutes/seconds part is 60 or more. */
function parseTime(text) {
  const parts = text.split(':').map(Number);
  if (parts.slice(1).some((part) => part >= 60)) return NaN;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

/** 75.5 → "1:15.5", 3723 → "1:02:03". */
function formatTime(seconds) {
  const whole = Math.floor(seconds);
  const fraction = Math.round((seconds - whole) * 10);
  const [h, m, s] = [Math.floor(whole / 3600), Math.floor(whole / 60) % 60, whole % 60];
  const clock = h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  return fraction ? `${clock}.${fraction}` : clock;
}

const clipError = (message) => Object.assign(new Error(message), { clipMessage: message });

/** The video in a message: a video, a GIF (animation) or an MP4 sent as a file. */
const videoIn = (message) =>
  message?.video ?? message?.animation ?? (message?.document?.mime_type?.startsWith('video/') ? message.document : undefined);

/** The key and item number behind a video the bot sent: from its screenshot button, else its caption link. */
async function keyOfBotVideo(message, video) {
  for (const button of message.reply_markup?.inline_keyboard?.flat() ?? []) {
    const match = button.callback_data?.match(SCREENSHOT_DATA);
    if (match && requestFor(match[3])) return { key: match[3], n: Number(match[2]) };
  }
  const key = postOfMessage(message);
  if (key) {
    const media = await getMedia(key);
    // The video in the post closest in length to the one replied to (posts may hold several).
    const videos = media.items.map((item, i) => ({ item, n: i + 1 })).filter(({ item }) => item.kind === 'video');
    const best = videos.sort((a, b) => Math.abs((a.item.duration ?? 0) - video.duration) - Math.abs((b.item.duration ?? 0) - video.duration))[0];
    if (best) return { key, n: best.n };
  }
  return null;
}

/*
 * Which post a message the bot sent belongs to: remembered when it was sent (by message id,
 * and by album, so any item of an album works), else read from its caption's "Open on …"
 * link. The memory is lost when the bot restarts; captions are on the first item of each album.
 */
const sentPosts = new Map(); // "<chat id>:<message id>" or "<chat id>:g<media group id>" -> key
const SENT_POSTS_MAX = 5000;

function rememberPost(message, key) {
  for (const id of [message.message_id, message.media_group_id && `g${message.media_group_id}`].filter(Boolean)) {
    const slot = `${message.chat.id}:${id}`;
    sentPosts.delete(slot);
    sentPosts.set(slot, key);
  }
  while (sentPosts.size > SENT_POSTS_MAX) sentPosts.delete(sentPosts.keys().next().value);
}

function postOfMessage(message) {
  const remembered =
    sentPosts.get(`${message.chat.id}:${message.message_id}`) ??
    (message.media_group_id && sentPosts.get(`${message.chat.id}:g${message.media_group_id}`));
  if (remembered && requestFor(remembered)) return remembered;
  for (const entity of message.caption_entities ?? []) {
    if (entity.type !== 'text_link') continue;
    const link =
      parseInstagramLink(entity.url) ?? parseFacebookLink(entity.url) ?? parseRedditLink(entity.url) ??
      parseSnapchatLink(entity.url) ?? parseXLink(entity.url) ?? parseThreadsLink(entity.url);
    if (link?.key && requestFor(link.key) && !needsLogin(link.key)) return link.key;
  }
  return null;
}

/** Downloads a file (≤ 20 MB) from Telegram's servers. The URL holds the bot token: never log it. */
async function downloadFromTelegram(fileId, file) {
  const { file_path: filePath } = await bot.api.getFile(fileId);
  const res = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`, { signal: AbortSignal.timeout(5 * 60_000) });
  if (!res.ok) throw new Error(`Telegram file download failed: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
}

/**
 * The file of the video replied to, for /clip and /frame: downloaded from Telegram (≤ 20 MB),
 * else, for a video the bot sent, its cached download. Returns { source, found, caption }
 * (found/caption only when the post is known). Throws clipError with a message for the user.
 */
async function videoSource(ctx, target, video, workDir) {
  const fromBot = target.from?.id === ctx.me.id;
  const found = fromBot ? await keyOfBotVideo(target, video) : null;
  if (found && isReddit(found.key) && !mayUseReddit(ctx.from?.id)) throw clipError(REDDIT_OWNER_ONLY);
  let source;
  if (video.file_size && video.file_size <= TELEGRAM_DOWNLOAD_LIMIT) {
    source = path.join(workDir, 'source');
    await downloadFromTelegram(video.file_id, source);
  } else if (found) {
    const media = await getMedia(found.key); // the cached download, or downloaded again
    source = media.items[found.n - 1]?.file;
  }
  if (!source) {
    throw clipError(
      fromBot
        ? "That video is over 20 MB and I couldn't find where it came from. Send me its link again, then reply to the new one."
        : 'That video is over 20 MB, the most a bot can download from Telegram. Send me a link to it instead.',
    );
  }
  const caption = found ? buildCaption(await getMedia(found.key), found.key) : '';
  return { source, found, caption };
}

bot.command(['clip', 'c'], async (ctx) => {
  const replyOptions = { reply_parameters: { message_id: ctx.msg.message_id } };
  if (!mayScreenshot(ctx.from?.id)) return ctx.reply('Clips are only for the bot’s owner.', replyOptions);
  const target = ctx.msg.reply_to_message;
  const video = videoIn(target);
  if (!video) return ctx.reply(CLIP_USAGE, { ...replyOptions, parse_mode: 'HTML' });
  const range = ctx.match.trim().match(CLIP_RANGE);
  const start = range ? parseTime(range[1]) : NaN;
  const end = range ? parseTime(range[2]) : NaN;
  if (!(start >= 0 && end > start)) return ctx.reply(CLIP_USAGE, { ...replyOptions, parse_mode: 'HTML' });
  if (end - start > CLIP_MAX_SECONDS) return ctx.reply(`A clip can be at most ${CLIP_MAX_SECONDS} seconds.`, replyOptions);
  sendClip(ctx, target, video, start, end).catch((err) => console.error('sendClip failed:', err));
});

async function sendClip(ctx, target, video, start, end) {
  const replyOptions = { reply_parameters: { message_id: target.message_id, allow_sending_without_reply: true } };
  const label = `${formatTime(start)}–${formatTime(end)}`;
  const loader = await startLoader(ctx, `Cutting ${label}…`, { replyTo: target.message_id });
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'insta-reel-bot-clip-'));
  let found = null;
  try {
    const got = await videoSource(ctx, target, video, workDir);
    const { source, caption } = got;
    found = got.found;

    const length = await videoDuration(source);
    if (!(start < length)) throw clipError(`That video is only ${formatTime(length)} long.`);
    const stop = Math.min(end, length);
    const out = path.join(workDir, 'clip.mp4');
    await cutClip(source, out, start, stop);
    const size = (await fs.stat(out)).size;
    if (size > UPLOAD_LIMIT.video) throw clipError('That clip is over 50 MB, too big for Telegram. Try a shorter part.');

    loader.set('Sending the clip…');
    const header = `✂️ ${formatTime(start)}–${formatTime(stop)}`;
    await ctx.replyWithVideo(new InputFile(out), {
      ...videoOptions({ width: video.width, height: video.height, duration: stop - start }),
      caption: caption ? `${header}\n${caption}` : header,
      parse_mode: 'HTML',
      ...replyOptions,
    });
    await loader.done();
    console.log(`[clip] sent ${header} (${(size / 1024 / 1024).toFixed(1)} MB) to chat ${ctx.chat.id}${found ? ` from ${found.key}` : ''}`);
  } catch (err) {
    console.error('[clip]', err?.stderr || err);
    await loader.fail(`❌ ${err.clipMessage ?? (err?.clip ? "Couldn't cut that video. Try again, or try other times." : describeError(err, found?.key ?? ''))}`);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

// ---------- /frame ----------
// Reply to a video with "/frame 0:12" (or several times, "/frame 0:12 0:15 0:31") to get the
// exact frame at each time as a full-resolution picture; add "file" to get them as files
// (uncompressed by Telegram). Open to everyone who may use the bot.
const FRAME_MAX = 10;
const FRAME_USAGE =
  'Reply to a video with <code>/frame 0:12</code> to get the picture at that moment.\n' +
  `Several at once: <code>/frame 0:12 0:15 0:31</code> (up to ${FRAME_MAX}). Add <code>file</code> to get them uncompressed.\n` +
  `Just <code>/frame</code> gives ${SCREENSHOT_COUNT} pictures spread across the video.`;
const FRAME_TIME = new RegExp(`^${TIME}$`);

bot.command(['frame', 'f'], (ctx) => {
  const replyOptions = { reply_parameters: { message_id: ctx.msg.message_id } };
  const target = ctx.msg.reply_to_message;
  const video = videoIn(target);
  const words = ctx.match.trim().split(/[\s,]+/).filter(Boolean);
  const asFile = words.at(-1)?.toLowerCase() === 'file';
  if (asFile) words.pop();
  const times = words.map((word) => (FRAME_TIME.test(word) ? parseTime(word) : NaN));
  // No times: SCREENSHOT_COUNT frames spread across the video, like the screenshot button.
  if (!video || times.some((time) => !(time >= 0))) {
    return ctx.reply(FRAME_USAGE, { ...replyOptions, parse_mode: 'HTML' });
  }
  if (times.length > FRAME_MAX) return ctx.reply(`At most ${FRAME_MAX} times at once.`, replyOptions);
  sendFrames(ctx, target, video, [...new Set(times)], asFile).catch((err) => console.error('sendFrames failed:', err));
});

async function sendFrames(ctx, target, video, times, asFile) {
  const replyOptions = { reply_parameters: { message_id: target.message_id, allow_sending_without_reply: true } };
  const spread = times.length === 0;
  const loader = await startLoader(ctx, spread ? `Taking ${SCREENSHOT_COUNT} screenshots…` : times.length === 1 ? `Grabbing ${formatTime(times[0])}…` : `Grabbing ${times.length} frames…`, {
    replyTo: target.message_id,
    action: asFile ? 'upload_document' : 'upload_photo',
  });
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'insta-reel-bot-frame-'));
  let found = null;
  try {
    const got = await videoSource(ctx, target, video, workDir);
    found = got.found;
    const length = await videoDuration(got.source);
    const frames = spread ? await dropRepeats(await extractFrames(got.source, workDir, SCREENSHOT_COUNT, length)) : [];
    for (const [i, time] of times.entries()) {
      if (!(time < length)) continue;
      const file = path.join(workDir, `frame-${String(i + 1).padStart(2, '0')}-${formatTime(time).replace(/[:.]/g, '_')}.jpg`);
      if (await grabFrameAt(got.source, file, time)) frames.push({ file, time });
    }
    if (!frames.length) throw clipError(`That video is only ${formatTime(length)} long.`);
    const skipped = spread ? 0 : times.length - frames.length;

    loader.set(frames.length === 1 ? 'Sending the frame…' : `Sending ${frames.length} frames…`);
    const header = `🖼 ${frames.map(({ time }) => formatTime(time)).join(', ')}` + (skipped ? ` (${skipped} past the end of the video)` : '');
    const caption = got.caption ? `${header}\n${got.caption}` : header;
    if (asFile) {
      if (frames.length === 1) await ctx.replyWithDocument(new InputFile(frames[0].file), { caption, parse_mode: 'HTML', ...replyOptions });
      else {
        await ctx.replyWithMediaGroup(
          frames.map(({ file }, j) => InputMediaBuilder.document(new InputFile(file), j === frames.length - 1 ? { caption, parse_mode: 'HTML' } : {})),
          replyOptions,
        );
      }
    } else {
      await sendAlbums(ctx, frames.map(({ file }) => ({ file, kind: 'photo' })), { caption, parse_mode: 'HTML' }, replyOptions);
    }
    await loader.done();
    console.log(`[frame] sent ${frames.length} frame(s)${asFile ? ' as files' : ''} to chat ${ctx.chat.id}${found ? ` from ${found.key}` : ''}`);
  } catch (err) {
    console.error('[frame]', err?.stderr || err);
    await loader.fail(`❌ ${err.clipMessage ?? (err?.source === 'ffmpeg' ? "Couldn't grab that frame. Try again, or try another time." : describeError(err, found?.key ?? ''))}`);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

// ---------- /file ----------
// Reply to a photo or video the bot sent (any item of an album) with "/file" to get the whole
// post as files: the downloaded originals, which Telegram doesn't recompress. "/file 3" sends
// only item 3. Open to everyone who may use the bot. Re-uploads, so it uses bandwidth.
const FILE_USAGE =
  'Reply to a photo, video or album I sent with <code>/file</code> to get the originals as files (full quality).\n' +
  '<code>/file 3</code> sends only item 3.';

bot.command('file', (ctx) => {
  const replyOptions = { reply_parameters: { message_id: ctx.msg.message_id } };
  const target = ctx.msg.reply_to_message;
  const hasMedia = target?.photo || videoIn(target);
  if (!hasMedia) return ctx.reply(FILE_USAGE, { ...replyOptions, parse_mode: 'HTML' });
  const key = target.from?.id === ctx.me.id ? postOfMessage(target) : null;
  if (!key) {
    return ctx.reply(
      target.from?.id === ctx.me.id
        ? "I don't know which post that came from any more. Send me its link again, then reply /file to the new one."
        : 'I only have the originals of things I downloaded. Reply /file to a photo or video I sent.',
      replyOptions,
    );
  }
  if (isReddit(key) && !mayUseReddit(ctx.from?.id)) return ctx.reply(REDDIT_OWNER_ONLY, replyOptions);
  const arg = ctx.match.trim();
  const only = /^\d{1,3}$/.test(arg) ? Number(arg) : undefined;
  if (arg && !only) return ctx.reply(FILE_USAGE, { ...replyOptions, parse_mode: 'HTML' });
  sendFiles(ctx, target, key, only).catch((err) => console.error(`[${key}] sendFiles failed:`, err));
});

async function sendFiles(ctx, target, key, only) {
  const replyOptions = { reply_parameters: { message_id: target.message_id, allow_sending_without_reply: true } };
  const loader = await startLoader(ctx, 'Getting the original files…', { replyTo: target.message_id, action: 'upload_document' });
  try {
    const media = await getMedia(key); // the cached download, or downloaded again
    const all = media.items.map((item, i) => ({ ...item, n: i + 1 }));
    if (only && !all[only - 1]) throw clipError(`This post has only ${all.length} item${all.length === 1 ? '' : 's'}.`);
    const wanted = only ? [all[only - 1]] : all;
    const files = wanted.filter((item) => (item.size ?? 0) <= UPLOAD_LIMIT.video); // documents: 50 MB
    if (!files.length) throw clipError('That file is over 50 MB, too big for Telegram.');
    const caption = buildCaption(media, key);
    const named = (item) => new InputFile(item.file, `${key}-${String(item.n).padStart(2, '0')}${path.extname(item.file)}`);

    loader.set(files.length === 1 ? 'Sending the file…' : `Sending ${files.length} files…`);
    for (let i = 0; i < files.length; i += ALBUM_LIMIT) {
      const chunk = files.slice(i, i + ALBUM_LIMIT);
      if (chunk.length === 1) {
        await ctx.replyWithDocument(named(chunk[0]), { caption, parse_mode: 'HTML', ...replyOptions });
        continue;
      }
      await ctx.replyWithMediaGroup(
        chunk.map((item, j) => InputMediaBuilder.document(named(item), j === chunk.length - 1 ? { caption, parse_mode: 'HTML' } : {})),
        replyOptions,
      );
    }
    const skipped = wanted.length - files.length;
    if (skipped) await ctx.reply(`⚠️ ${skipped} file${skipped === 1 ? ' is' : 's are'} over 50 MB, too big for Telegram.`, replyOptions);
    await loader.done();
    console.log(`[${key}] sent ${files.length} file(s) to chat ${ctx.chat.id}`);
  } catch (err) {
    console.error(`[${key}] /file`, err?.stderr || err);
    await loader.fail(`❌ ${err.clipMessage ?? describeError(err, key)}`);
  }
}

// ---------- /sticker ----------
// Reply to a photo (or an image sent as a file, which keeps transparency) with "/sticker" or
// "/sticker 😂" to get it as a Telegram sticker, or send a photo with /sticker as its caption.
// "➕ Add to my pack" puts it in the tapping user's own pack (created on first use, owned by
// them). Open to everyone who may use the bot.
const STICKER_EMOJI = '🙂';
const STICKER_PACK_DATA = 'sp';
const STICKER_USAGE =
  'Reply to a photo with <code>/sticker</code> (or <code>/sticker 😂</code> to pick its emoji) to turn it into a sticker.\n' +
  'Tip: send a PNG with a transparent background <b>as a file</b> to keep the transparency.';

/** The image in a message: the largest photo size, or a PNG/JPEG/WEBP sent as a file. */
const imageIn = (message) =>
  message?.photo?.at(-1) ??
  (/^image\/(png|jpeg|webp)$/.test(message?.document?.mime_type ?? '') ? message.document : undefined);

/** The first emoji in `text`, else the default. */
function stickerEmoji(text) {
  for (const { segment } of new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text ?? '')) {
    if (/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(segment)) return segment;
  }
  return STICKER_EMOJI;
}

// The user's own pack: t.me/addstickers/<name>. Names must end in _by_<bot username>.
const packName = (userId) => `u${userId}_by_${bot.botInfo.username}`;

bot.command('sticker', (ctx) => {
  // A photo with "/sticker" as its caption, or a reply to one.
  const target = imageIn(ctx.msg) ? ctx.msg : ctx.msg.reply_to_message;
  const image = imageIn(target);
  if (!image) return ctx.reply(STICKER_USAGE, { parse_mode: 'HTML', reply_parameters: { message_id: ctx.msg.message_id } });
  if (image.file_size && image.file_size > TELEGRAM_DOWNLOAD_LIMIT) {
    return ctx.reply('That image is over 20 MB, the most a bot can download from Telegram.', {
      reply_parameters: { message_id: ctx.msg.message_id },
    });
  }
  sendSticker(ctx, target, image, stickerEmoji(ctx.match)).catch((err) => console.error('sendSticker failed:', err));
});

async function sendSticker(ctx, target, image, emoji) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'insta-reel-bot-sticker-'));
  try {
    await ctx.replyWithChatAction('choose_sticker').catch(() => {});
    const source = path.join(workDir, 'source');
    await downloadFromTelegram(image.file_id, source);
    const webp = await makeSticker(source, path.join(workDir, 'sticker.webp'));
    await ctx.replyWithSticker(new InputFile(webp), {
      emoji,
      reply_parameters: { message_id: target.message_id, allow_sending_without_reply: true },
      reply_markup: new InlineKeyboard().text('➕ Add to my pack', STICKER_PACK_DATA),
    });
    console.log(`[sticker] sent ${emoji} sticker to chat ${ctx.chat.id}`);
  } catch (err) {
    console.error('[sticker]', err?.stderr || err);
    const text = err?.sticker ? "Couldn't turn that image into a sticker. Try another one." : describeError(err, '');
    await ctx.reply(`❌ ${text}`, { reply_parameters: { message_id: target.message_id, allow_sending_without_reply: true } }).catch(() => {});
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

// "➕ Add to my pack": adds the sticker to the tapping user's pack, creating it the first time.
bot.callbackQuery(STICKER_PACK_DATA, async (ctx) => {
  const sticker = ctx.callbackQuery.message?.sticker;
  const user = ctx.from;
  if (!sticker) return ctx.answerCallbackQuery().catch(() => {});
  const name = packName(user.id);
  const input = { sticker: sticker.file_id, format: 'static', emoji_list: [sticker.emoji || STICKER_EMOJI] };
  try {
    const exists = await bot.api.getStickerSet(name).then(
      () => true,
      (err) => (/STICKERSET_INVALID/i.test(err?.description ?? '') ? false : Promise.reject(err)),
    );
    if (exists) {
      await bot.api.addStickerToSet(user.id, name, input);
      await ctx.answerCallbackQuery({ text: '✅ Added to your sticker pack' }).catch(() => {});
    } else {
      const title = `${user.first_name || 'My'}’s stickers`.slice(0, 64);
      await bot.api.createNewStickerSet(user.id, name, title, [input]);
      await ctx.answerCallbackQuery({ text: '✅ Pack created' }).catch(() => {});
      await ctx.reply(
        `✅ Created your sticker pack. Open it to add it to Telegram: https://t.me/addstickers/${name}\n` +
          'Every ➕ you tap adds to the same pack. Rename or reorder it with @Stickers.',
        { link_preview_options: { is_disabled: true } },
      );
    }
    console.log(`[sticker] ${exists ? 'added to' : 'created'} pack ${name}`);
  } catch (err) {
    const detail = err?.description ?? String(err);
    console.error(`[sticker] pack ${name}:`, detail);
    const text = /STICKERS_TOO_MUCH/i.test(detail)
      ? 'Your pack is full (120 stickers). Remove some with @Stickers.'
      : /PEER_ID_INVALID|USER_IS_BOT|bot was blocked|can't initiate/i.test(detail)
        ? 'Open a private chat with me and press Start first, then tap ➕ again.'
        : "Couldn't add it to your pack. Try again in a bit.";
    await ctx.answerCallbackQuery({ text, show_alert: true }).catch(() => {});
  }
});

// ---------- /pdf ----------
// Photos → one PDF (A4 pages, src/pdf.js), open to everyone who may use the bot:
// - reply to a photo, or any item of an album, with "/pdf [name]": that photo, or the whole album;
// - or send an album (or one photo/image file) with "/pdf [name]" as its caption.
// The Bot API can't fetch an album's other messages, so every album the bot sends (re-sent
// media and downloads) is remembered by its media group id (sentAlbums, lost on restart).
const PDF_MAX_PAGES = 50;
const PDF_USAGE =
  'Reply to a photo or an album with <code>/pdf</code> to get it as one PDF (A4 pages). ' +
  '<code>/pdf Notes</code> names it Notes.pdf.\nOr send an album with <code>/pdf</code> as its caption.';
const pdfAlbums = new Map(); // "<chat>:<media group id>" -> { pages, name, timer }: albums captioned /pdf, arriving
const sentAlbums = new Map(); // "<chat>:g<media group id>" -> pages of an album the bot sent
const SENT_ALBUMS_MAX = 2000;

/** The image in a message as a PDF page: the largest photo size, or an image sent as a file. */
const pdfPageOf = (message) => {
  const image = imageIn(message);
  return image ? { fileId: image.file_id, size: image.file_size ?? 0, order: message.message_id } : null;
};

/** Remembers the photos of an album the bot sent, so /pdf on any item of it gets them all. */
function rememberAlbum(messages) {
  const group = messages[0]?.media_group_id;
  if (!group) return;
  const pages = messages.map(pdfPageOf).filter(Boolean);
  if (!pages.length) return;
  sentAlbums.set(`${messages[0].chat.id}:g${group}`, pages);
  while (sentAlbums.size > SENT_ALBUMS_MAX) sentAlbums.delete(sentAlbums.keys().next().value);
}

/** "Notes 2026" → "Notes 2026.pdf"; nothing usable → "photos-2026-11-26.pdf". */
function pdfFileName(text) {
  const name = (text ?? '').replace(/[^\p{L}\p{M}\p{N} ._()-]+/gu, '').replace(/^[.\s]+/, '').trim().slice(0, 60).replace(/\.pdf$/i, '');
  return `${name || `photos-${new Date().toISOString().slice(0, 10)}`}.pdf`;
}

bot.command('pdf', (ctx) => {
  const name = pdfFileName(ctx.match);
  const own = pdfPageOf(ctx.msg);
  // An album with /pdf as its caption: its other items arrive as separate messages.
  if (own && ctx.msg.media_group_id) {
    const slot = `${ctx.chat.id}:${ctx.msg.media_group_id}`;
    const album = pdfAlbums.get(slot) ?? { pages: [] };
    album.name = name;
    album.pages.push(own, ...takePendingAlbumItems(ctx.chat.id, ctx.msg));
    pdfAlbums.set(slot, album);
    schedulePdfAlbum(ctx, slot, album);
    return;
  }
  if (own) return makePdf(ctx, [own], name, ctx.msg.message_id).catch((err) => console.error('[pdf] failed:', err));

  // A reply to a photo or an album item.
  const target = ctx.msg.reply_to_message;
  const page = pdfPageOf(target);
  if (!page) return ctx.reply(PDF_USAGE, { parse_mode: 'HTML', reply_parameters: { message_id: ctx.msg.message_id } });
  const remembered = target.media_group_id && sentAlbums.get(`${ctx.chat.id}:g${target.media_group_id}`);
  const pages = remembered || [page];
  const note =
    target.media_group_id && !remembered
      ? 'Only the photo you replied to: I no longer remember the rest of that album. Send the photos again to get them all.'
      : '';
  makePdf(ctx, pages, name, target.message_id, note).catch((err) => console.error('[pdf] failed:', err));
});

/** Album items that arrived before the /pdf caption went to the re-send queue: take them back. */
function takePendingAlbumItems(chatId, message) {
  const pending = pendingMedia.get(`${chatId}:${topicOf(message).message_thread_id ?? ''}`);
  if (!pending) return [];
  const mine = pending.items.filter((item) => item.group === message.media_group_id && item.kind === 'photo');
  pending.items = pending.items.filter((item) => !mine.includes(item));
  return mine.map((item) => ({ fileId: item.file, size: item.size ?? 0, order: item.order }));
}

/** Builds a /pdf-captioned album's PDF once none of its items came for COLLECT_MS. */
function schedulePdfAlbum(ctx, slot, album) {
  clearTimeout(album.timer);
  album.timer = setTimeout(() => {
    pdfAlbums.delete(slot);
    const first = Math.min(...album.pages.map((page) => page.order));
    makePdf(ctx, album.pages, album.name, first).catch((err) => console.error('[pdf] album failed:', err));
  }, COLLECT_MS);
}

/** Called first for every photo/image file: keeps it if its album is captioned /pdf. Returns true if taken. */
function takeForPdf(ctx) {
  const message = ctx.message;
  const album = message.media_group_id && pdfAlbums.get(`${ctx.chat.id}:${message.media_group_id}`);
  const page = album && pdfPageOf(message);
  if (!page) return false;
  album.pages.push(page);
  schedulePdfAlbum(ctx, `${ctx.chat.id}:${message.media_group_id}`, album);
  return true;
}

/** Downloads the pages from Telegram and sends them back as one PDF. */
async function makePdf(ctx, pages, name, replyTo, note = '') {
  const sorted = [...pages].sort((a, b) => a.order - b.order).slice(0, PDF_MAX_PAGES);
  const loader = await startLoader(ctx, `Making the PDF (${sorted.length} page${sorted.length === 1 ? '' : 's'})…`, {
    replyTo,
    action: 'upload_document',
  });
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'insta-reel-bot-pdf-'));
  try {
    const tooBig = sorted.filter((page) => page.size > TELEGRAM_DOWNLOAD_LIMIT).length;
    const usable = sorted.filter((page) => page.size <= TELEGRAM_DOWNLOAD_LIMIT);
    if (!usable.length) throw clipError('Those images are over 20 MB, the most a bot can download from Telegram.');
    const jpegs = [];
    for (const [i, page] of usable.entries()) {
      const source = path.join(workDir, `page-${String(i + 1).padStart(2, '0')}`);
      await downloadFromTelegram(page.fileId, source);
      const info = jpegInfo(await fs.readFile(source));
      jpegs.push(embeddable(info) ? source : await toJpeg(source, `${source}.jpg`));
    }
    const pdf = await buildPdf(jpegs, path.join(workDir, 'out.pdf'));
    const size = (await fs.stat(pdf)).size;
    if (size > UPLOAD_LIMIT.video) throw clipError('That PDF would be over 50 MB, too big for Telegram. Try fewer photos.');
    loader.set('Sending the PDF…');
    const notes = [
      tooBig ? `⚠️ ${tooBig} image${tooBig === 1 ? ' was' : 's were'} over 20 MB and left out.` : '',
      note ? `⚠️ ${note}` : '',
    ].filter(Boolean);
    await ctx.replyWithDocument(new InputFile(pdf, name), {
      caption: [`📄 ${jpegs.length} page${jpegs.length === 1 ? '' : 's'}`, ...notes].join('\n'),
      reply_parameters: { message_id: replyTo, allow_sending_without_reply: true },
    });
    await loader.done();
    console.log(`[pdf] sent ${jpegs.length} page(s), ${(size / 1024 / 1024).toFixed(1)} MB, to chat ${ctx.chat.id}`);
  } catch (err) {
    console.error('[pdf]', err?.stderr || err);
    await loader.fail(
      `❌ ${err.clipMessage ?? (err?.source === 'ffmpeg' ? "Couldn't read one of those images. Try sending it as a photo." : describeError(err, ''))}`,
    );
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

// Images sent as files: only used for an album captioned /pdf (otherwise files are ignored).
bot.on('message:document', (ctx) => {
  takeForPdf(ctx);
});

// ---------- /stats ----------
// Owner only. Render's outbound bandwidth (the free plan's 5 GB/month limit) from Render's
// metrics API, the same hourly numbers as the dashboard's "Outbound Bandwidth" chart, plus what
// the bot did since it last started (lost when the free instance sleeps). Needs RENDER_API_KEY;
// Render sets RENDER_SERVICE_ID itself.
const RENDER_API_KEY = process.env.RENDER_API_KEY?.trim();
const RENDER_SERVICE_ID = process.env.RENDER_SERVICE_ID?.trim();
const BANDWIDTH_LIMIT_GB = Number(process.env.BANDWIDTH_LIMIT_GB) || 5;
const STATS_TIMEZONE = process.env.STATS_TIMEZONE?.trim() || 'UTC';
const sinceStart = { at: Date.now(), bySite: new Map(), users: new Set() };

/** Counts a delivered download for /stats. */
function countDownload(key, userId) {
  const site = siteName(key);
  sinceStart.bySite.set(site, (sinceStart.bySite.get(site) ?? 0) + 1);
  if (userId) sinceStart.users.add(userId);
}

/** Hourly outbound MB by traffic source ("total", "nat" = the bot's own requests, "http" = answers) since `start`. */
async function renderBandwidth(start) {
  const url = new URL('https://api.render.com/v1/metrics/bandwidth-sources');
  url.searchParams.set('resource', RENDER_SERVICE_ID);
  url.searchParams.set('startTime', start.toISOString());
  url.searchParams.set('endTime', new Date().toISOString());
  const res = await fetch(url, { headers: { Authorization: `Bearer ${RENDER_API_KEY}` }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Render metrics API: HTTP ${res.status}`);
  const series = {};
  for (const s of await res.json()) {
    const source = s.labels?.find((label) => label.field === 'trafficSource')?.value;
    if (source) series[source] = (s.values ?? []).map((v) => ({ at: new Date(v.timestamp), mb: Number(v.value) || 0 }));
  }
  return series;
}

const formatMb = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`);
const bar = (fraction, width) => {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
};
const dayKey = (date) => date.toLocaleDateString('en-CA', { timeZone: STATS_TIMEZONE }); // YYYY-MM-DD
const dayLabel = (date) => date.toLocaleDateString('en-GB', { timeZone: STATS_TIMEZONE, day: '2-digit', month: 'short' });

async function bandwidthLines() {
  if (!RENDER_API_KEY || !RENDER_SERVICE_ID) {
    return ['Bandwidth: set <code>RENDER_API_KEY</code> on Render to see it here.'];
  }
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)); // Render bills by calendar month (UTC)
  const series = await renderBandwidth(monthStart);
  const total = series.total ?? [];
  const sum = (points) => points.reduce((acc, p) => acc + p.mb, 0);
  const used = sum(total);
  const limit = BANDWIDTH_LIMIT_GB * 1024;
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  // Projection: the last 7 days' daily average for the rest of the month (the whole month's
  // average would be too low for a month the service started partway through).
  const weekAgo = new Date(now - 7 * 86_400_000);
  const lastWeek = sum(total.filter((p) => p.at >= weekAgo));
  const firstPoint = total[0]?.at ?? now;
  const weekDays = Math.max(1 / 24, (now - Math.max(weekAgo, firstPoint)) / 86_400_000);
  const remainingDays = (new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), daysInMonth + 1)) - now) / 86_400_000;
  const projected = used + (lastWeek / weekDays) * remainingDays;

  // The last 7 days, by day in STATS_TIMEZONE.
  const perDay = new Map();
  for (let i = 6; i >= 0; i--) {
    const day = new Date(now - i * 86_400_000);
    perDay.set(dayKey(day), { label: dayLabel(day), mb: 0 });
  }
  for (const p of total) {
    const slot = perDay.get(dayKey(p.at));
    if (slot) slot.mb += p.mb;
  }
  const busiest = Math.max(1, ...[...perDay.values()].map((d) => d.mb));
  const peak = total.reduce((best, p) => (p.mb > (best?.mb ?? 0) ? p : best), null);

  const lines = [
    `📶 <b>Bandwidth this month</b> (Render, outbound)`,
    `<code>${bar(used / limit, 20)}</code> ${formatMb(used)} of ${BANDWIDTH_LIMIT_GB} GB (${Math.round((used / limit) * 100)}%)`,
    `Telegram uploads and downloads: ${formatMb(sum(series.nat ?? []))} · webhook answers: ${formatMb(sum(series.http ?? []))}`,
    `At last week’s rate (${formatMb(lastWeek / weekDays)}/day): ~${formatMb(projected)} by the end of the month${projected > limit ? ' ⚠️ over the limit' : ''}`,
    '',
    `<b>Last 7 days</b> (${escapeHtml(STATS_TIMEZONE)})`,
    `<pre>${[...perDay.values()].map((d) => `${d.label}  ${bar(d.mb / busiest, 12)} ${formatMb(d.mb).padStart(7)}`).join('\n')}</pre>`,
  ];
  if (peak) {
    const when = peak.at.toLocaleString('en-GB', { timeZone: STATS_TIMEZONE, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    lines.push(`Busiest hour this month: ${formatMb(peak.mb)} at ${when}`);
  }
  return lines;
}

/** Reads a cgroup v2 file of this container; undefined outside Linux containers (e.g. on a Mac). */
const cgroup = (name) => fs.readFile(`/sys/fs/cgroup/${name}`, 'utf8').then((text) => text.trim(), () => undefined);

/**
 * Memory and CPU of this container right now (cgroup v2, as on Render), else of the Node process.
 * Since the container started, so a sleep or deploy resets them.
 */
async function resourceLines() {
  const mb = (bytes) => Number(bytes) / 1024 / 1024;
  const [current, peak, max, cpuStat, cpuMax] = await Promise.all(
    ['memory.current', 'memory.peak', 'memory.max', 'cpu.stat', 'cpu.max'].map(cgroup),
  );
  const used = current ? mb(current) : mb(process.memoryUsage().rss);
  const limit = max && max !== 'max' ? mb(max) : os.totalmem() / 1024 / 1024;
  const lines = [`🧠 <b>Memory</b>: <code>${bar(used / limit, 10)}</code> ${formatMb(used)} of ${formatMb(limit)}${peak ? ` · peak ${formatMb(mb(peak))}` : ''}`];
  // CPU: time used since start / wall time, as a share of the CPUs this container may use.
  const usageUsec = Number(cpuStat?.match(/usage_usec (\d+)/)?.[1]);
  const [quota, period] = (cpuMax ?? '').split(' ');
  const cpus = quota && quota !== 'max' ? Number(quota) / Number(period) : os.cpus().length;
  const cpuSeconds = usageUsec ? usageUsec / 1e6 : (process.cpuUsage().user + process.cpuUsage().system) / 1e6;
  const share = cpuSeconds / process.uptime() / cpus;
  lines.push(`⚙️ <b>CPU</b>: ${Math.round(share * 100)}% of ${cpus < 1 ? cpus.toFixed(1) : cpus} CPU on average since start`);
  return lines;
}

async function cacheSize() {
  let bytes = 0;
  let posts = 0;
  for (const entry of await fs.readdir(CACHE_DIR, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    posts++;
    for (const file of await fs.readdir(path.join(CACHE_DIR, entry.name)).catch(() => [])) {
      bytes += (await fs.stat(path.join(CACHE_DIR, entry.name, file)).catch(() => ({ size: 0 }))).size;
    }
  }
  return { posts, mb: bytes / 1024 / 1024 };
}

bot.command('stats', async (ctx) => {
  if (!isOwner(ctx.from?.id)) return ctx.reply(OWNER_ONLY, { reply_parameters: { message_id: ctx.msg.message_id } });
  await ctx.replyWithChatAction('typing').catch(() => {});
  let bandwidth;
  try {
    bandwidth = await bandwidthLines();
  } catch (err) {
    console.error('[stats]', err?.message ?? err);
    bandwidth = ['📶 Bandwidth: Render’s metrics API didn’t answer. Try again in a bit.'];
  }
  const uptimeMin = Math.round((Date.now() - sinceStart.at) / 60_000);
  const uptime = uptimeMin >= 60 ? `${Math.floor(uptimeMin / 60)} h ${uptimeMin % 60} min` : `${uptimeMin} min`;
  const total = [...sinceStart.bySite.values()].reduce((a, b) => a + b, 0);
  const bySite = [...sinceStart.bySite].sort((a, b) => b[1] - a[1]).map(([site, n]) => `${escapeHtml(site)} ${n}`).join(' · ');
  const cache = await cacheSize();
  const resources = await resourceLines().catch(() => []);
  const text = [
    ...bandwidth,
    '',
    ...resources,
    '',
    `🤖 <b>Since the bot started</b> (${uptime} ago; the free plan sleeps after 15 idle minutes)`,
    `Downloads sent: ${total}${bySite ? ` (${bySite})` : ''} · people: ${sinceStart.users.size}`,
    `Cache: ${cache.posts} post${cache.posts === 1 ? '' : 's'}, ${formatMb(cache.mb)} (kept 1 hour)`,
  ].join('\n');
  return ctx.reply(text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
});

// ---------- re-sending media ----------

// Photos and videos sent or forwarded to the bot come back without captions or "Forwarded
// from" headers. Several sent together (e.g. 3 forwarded at once) are collected for a moment
// and returned as albums of up to 10, then the originals are deleted. Telegram reuses the
// files by id; nothing is re-uploaded.
const COLLECT_MS = 1500; // how long to wait for more photos/videos from the same chat
const pendingMedia = new Map(); // "<chat id>:<topic id>" -> { items, timer }

bot.on(['message:photo', 'message:video'], (ctx) => {
  if (takeForPdf(ctx)) return; // a photo for a PDF being collected (/pdf)
  const { photo, video, message_id: order, media_group_id: group } = ctx.message;
  const item = video
    ? { kind: 'video', file: video.file_id, order, group }
    : { kind: 'photo', file: photo.at(-1).file_id, size: photo.at(-1).file_size, order, group };
  const chatId = ctx.chat.id;
  const topic = topicOf(ctx.message); // send the copies back into the same topic
  const slot = `${chatId}:${topic.message_thread_id ?? ''}`;
  const pending = pendingMedia.get(slot) ?? { items: [] };
  pending.items.push(item);
  clearTimeout(pending.timer);
  pending.timer = setTimeout(() => {
    pendingMedia.delete(slot);
    if (!pending.items.length) return; // all taken for a PDF (/pdf album)
    resendMedia(chatId, topic, pending.items).catch((err) => console.error('Re-sending media failed:', err));
  }, COLLECT_MS);
  pendingMedia.set(slot, pending);
});

async function resendMedia(chatId, topic, items) {
  items.sort((a, b) => a.order - b.order); // the order they were sent in
  try {
    for (let i = 0; i < items.length; i += ALBUM_LIMIT) {
      const chunk = items.slice(i, i + ALBUM_LIMIT);
      if (chunk.length === 1) {
        const [{ kind, file }] = chunk;
        if (kind === 'video') await bot.api.sendVideo(chatId, file, { ...topic, supports_streaming: true });
        else await bot.api.sendPhoto(chatId, file, topic);
        continue;
      }
      const sent = await bot.api.sendMediaGroup(
        chatId,
        chunk.map(({ kind, file }) =>
          kind === 'video' ? InputMediaBuilder.video(file, { supports_streaming: true }) : InputMediaBuilder.photo(file),
        ),
        topic,
      );
      rememberAlbum(sent); // so /pdf on any of them gets the whole album
    }
    // All copies are in the chat: remove the originals the user sent or forwarded.
    // (Only after full success; if sending failed above, they stay.)
    await bot.api.deleteMessages(chatId, items.map((item) => item.order)).catch(() => {});
    console.log(`Re-sent ${items.length} photo(s)/video(s) in chat ${chatId}`);
  } catch (err) {
    console.error('Re-sending media failed:', err?.description ?? err);
    await bot.api.sendMessage(chatId, `❌ ${describeError(err)}`, topic).catch(() => {});
  }
}

// ---------- links → downloads ----------

/**
 * A message with a link the bot doesn't support gets a short general reply listing what does
 * work, instead of silence. Only in private chats: in groups people share all kinds of links
 * that aren't meant for the bot. Plain text without a link is still ignored.
 */
function replyUnsupportedSite(ctx) {
  if (ctx.chat.type !== 'private') return;
  const hasLink = (ctx.message.entities ?? []).some((entity) => entity.type === 'url' || entity.type === 'text_link');
  if (!hasLink) return;
  const sites = ['Instagram', 'Facebook', ...(mayUseReddit(ctx.from?.id) ? ['Reddit'] : []), 'Snapchat', 'X (Twitter)', 'Threads'];
  return ctx.reply(
    `Sorry, I can’t download from that link. I support ${sites.slice(0, -1).join(', ')} and ${sites.at(-1)}.\n` +
      'Send /help to see what works for each.',
    { reply_parameters: { message_id: ctx.message.message_id }, link_preview_options: { is_disabled: true } },
  );
}

bot.on('message:text', (ctx) => {
  const text = ctx.message.text;
  const link = parseInstagramLink(text) ?? parseFacebookLink(text) ?? parseRedditLink(text) ?? parseSnapchatLink(text) ?? parseXLink(text) ?? parseThreadsLink(text);
  if (!link) return replyUnsupportedSite(ctx); // no supported link: say so for other sites' links (private chats only)
  if ((link.site === 'reddit' || (link.key && isReddit(link.key))) && !mayUseReddit(ctx.from?.id)) {
    return ctx.reply(REDDIT_OWNER_ONLY, { reply_parameters: { message_id: ctx.message.message_id } });
  }
  if (link.unsupported && link.site === 'threads') {
    return ctx.reply('From Threads I can download posts with photos or videos. Send a link to the post (… → Copy link).');
  }
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
    const resolve = { facebook: resolveFacebookShareLink, reddit: resolveRedditShareLink, snapchat: resolveSnapchatShareLink, x: resolveXShareLink, threads: resolveThreadsShareLink }[link.site] ?? resolveShareLink;
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
    const { complete, sent } = await deliver(ctx, key, media);
    await loader.done();
    await archiveCopy(ctx, key, sent);
    // Everything arrived, so the user's link message has done its job. After an error, or if
    // some items couldn't be sent, it stays so the user can see what they asked for.
    if (complete) await ctx.deleteMessage().catch(() => {});
    countDownload(key, ctx.from?.id);
    console.log(`[${key}] sent ${media.items.length} item(s) to chat ${ctx.chat.id}${complete ? '' : ' (incomplete)'}`);
  } catch (err) {
    console.error(`[${key ?? link.share}]`, err?.stderr || err);
    // The loader becomes the error (or the error is sent anew), so it never spins with no answer.
    const message = describeError(err, key);
    await loader.fail(`❌ ${message}`);
    const site = key ? siteName(key) : ({ facebook: 'Facebook', reddit: 'Reddit', snapchat: 'Snapchat', x: 'X', threads: 'Threads' })[link.site] ?? 'Instagram';
    await alertFailure(ctx, site, key ?? link.share, err, message);
  }
}

/**
 * Sends the downloaded items, then notes about skipped ones and screenshot buttons.
 * Returns { complete: every item was sent, sent: ids of the messages with media }.
 */
async function deliver(ctx, key, media) {
  const items = media.items.map((item, i) => ({ ...item, n: i + 1 }));
  const sendable = items.filter(fitsTelegram);
  const tooBig = items.filter((item) => !fitsTelegram(item));
  const videos = items.filter((item) => item.kind === 'video');
  // No buttons for people who may not take screenshots (see SCREENSHOT_USERS)
  const keyboard = mayScreenshot(ctx.from?.id) ? screenshotKeyboard(key, videos) : undefined;
  const buttons = keyboard ? { reply_markup: keyboard } : {};
  const caption = buildCaption(media, key);
  const single = items.length === 1;
  const complete = tooBig.length === 0 && !media.partial && !media.hidden;

  // One reel or photo: caption and button on the same message, like Instagram shows it.
  if (single && sendable.length === 1 && !media.partial && !media.hidden) {
    const message = await sendOne(ctx, sendable[0], { caption, parse_mode: 'HTML', ...buttons });
    rememberPost(message, key);
    return { complete, sent: [message.message_id] };
  }

  const sent = await sendAlbums(ctx, sendable, { caption, parse_mode: 'HTML' }, {}, key);

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
  if (notes.length === 0) return { complete, sent };
  // If nothing could be sent, the caption still belongs in the chat.
  const text = [sendable.length ? '' : caption, ...notes].filter(Boolean).join('\n\n');
  await ctx.reply(text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...buttons });
  return { complete, sent };
}

/**
 * Copies what another user downloaded into the owner's archive chat (ARCHIVE_CHAT_ID), after a
 * line saying who asked for it. Owners (OWNER_USER_IDS) aren't copied. copyMessages
 * reuses Telegram's files, so nothing is uploaded again. Failures are only logged.
 */
async function archiveCopy(ctx, key, messageIds) {
  const user = ctx.from;
  if (!ARCHIVE_CHAT_ID || !messageIds.length || !user || OWNER_USERS.has(user.id)) return;
  if (String(ctx.chat.id) === ARCHIVE_CHAT_ID) return;
  try {
    const name = escapeHtml([user.first_name, user.last_name].filter(Boolean).join(' ') || 'Someone');
    const where = ctx.chat.type === 'private' ? '' : ` in ${escapeHtml(ctx.chat.title ?? 'a group')}`;
    const header =
      `📥 <a href="tg://user?id=${user.id}">${name}</a>${user.username ? ` (@${escapeHtml(user.username)})` : ''}` +
      ` · <code>${user.id}</code>${where} · ${siteName(key)}`;
    const topic = ARCHIVE_TOPIC_ID ? { message_thread_id: ARCHIVE_TOPIC_ID } : {};
    await bot.api.sendMessage(ARCHIVE_CHAT_ID, header, { ...topic, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    await bot.api.copyMessages(ARCHIVE_CHAT_ID, ctx.chat.id, messageIds, topic);
  } catch (err) {
    console.error(`[${key}] archive copy failed:`, err?.description ?? err);
  }
}

/*
 * Failure alerts: when someone's download fails, a short note goes to the archive chat (same
 * ARCHIVE_CHAT_ID/ARCHIVE_TOPIC_ID), so a site that broke (Threads' doc_id, X rate limits, a yt-dlp
 * extractor) shows up before users complain. Not for owners (they see their own errors), nor for
 * expected answers (deleted post, expired story, text post). At most one per site every
 * ALERT_EVERY_MS; the next one says how many were held back.
 */
const ALERT_EVERY_MS = 10 * 60 * 1000;
const EXPECTED_FAILURES = new Set([
  'STORIES_PAUSED', 'NEEDS_LOGIN', 'NO_MEDIA', 'EXTERNAL_LINK', 'X_GONE', 'X_HIDDEN', 'THREADS_GONE',
  'SNAP_GONE', 'NO_STORY', 'SPOTLIGHT_HIDDEN',
]);
const lastAlert = new Map(); // site → { at, held }

async function alertFailure(ctx, site, keyOrLink, err, message) {
  const user = ctx.from;
  if (!ARCHIVE_CHAT_ID || !user || OWNER_USERS.has(user.id) || EXPECTED_FAILURES.has(err?.code)) return;
  const isKey = !/^https?:/.test(keyOrLink ?? '');
  const now = Date.now();
  const last = lastAlert.get(site);
  if (last && now - last.at < ALERT_EVERY_MS) {
    last.held++;
    return;
  }
  lastAlert.set(site, { at: now, held: 0 });
  try {
    const name = escapeHtml([user.first_name, user.last_name].filter(Boolean).join(' ') || 'Someone');
    const detail = `${err?.code ? `${err.code}: ` : ''}${String(err?.stderr || err?.message || err).trim()}`.slice(-400);
    const text = [
      `⚠️ <b>Download failed</b> · ${escapeHtml(site)}`,
      `${isKey ? 'Key' : 'Link'}: <code>${escapeHtml(keyOrLink ?? '?')}</code>`,
      `User: <a href="tg://user?id=${user.id}">${name}</a>${user.username ? ` (@${escapeHtml(user.username)})` : ''} · <code>${user.id}</code>`,
      `Told them: ${escapeHtml(message)}`,
      `<pre>${escapeHtml(detail)}</pre>`,
      last?.held ? `(+${last.held} more ${escapeHtml(site)} failure(s) in the last ${ALERT_EVERY_MS / 60000} minutes)` : '',
    ].filter(Boolean).join('\n');
    const topic = ARCHIVE_TOPIC_ID ? { message_thread_id: ARCHIVE_TOPIC_ID } : {};
    await bot.api.sendMessage(ARCHIVE_CHAT_ID, text, { ...topic, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  } catch (alertErr) {
    console.error('failure alert failed:', alertErr?.description ?? alertErr);
  }
}

// ---------- screenshot buttons ----------

bot.callbackQuery(SCREENSHOT_DATA, async (ctx) => {
  const count = ctx.match[1] === '1' ? 1 : SCREENSHOT_COUNT;
  const n = Number(ctx.match[2]);
  const key = ctx.match[3];
  if (!requestFor(key)) return ctx.answerCallbackQuery().catch(() => {});
  if (!mayScreenshot(ctx.from?.id)) return ctx.answerCallbackQuery({ text: SCREENSHOTS_OWNER_ONLY }).catch(() => {});
  if (isReddit(key) && !mayUseReddit(ctx.from?.id)) return ctx.answerCallbackQuery({ text: REDDIT_OWNER_ONLY }).catch(() => {});
  // A tap that waited while the bot was restarting can't be answered any more (Telegram allows
  // ~15 s); that's only the little toast, so still send the screenshots.
  await ctx.answerCallbackQuery({ text: count === 1 ? '📸 Grabbing a screenshot…' : '📸 Grabbing screenshots…' }).catch(() => {});
  sendScreenshots(ctx, key, n, count).catch((err) => console.error(`[${key}] sendScreenshots failed:`, err));
});

// "✖️ Cancel": the user doesn't want screenshots. A text message that only carried the buttons
// is deleted; a photo or video just loses its buttons.
bot.callbackQuery(DISMISS_DATA, async (ctx) => {
  if (!mayScreenshot(ctx.from?.id)) return ctx.answerCallbackQuery({ text: SCREENSHOTS_OWNER_ONLY }).catch(() => {});
  await ctx.answerCallbackQuery().catch(() => {});
  if (ctx.callbackQuery.message?.text !== undefined) return ctx.deleteMessage().catch(() => {});
  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
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
  // The "/" menu. Everyone sees every command; owner-only ones answer others with OWNER_ONLY.
  await bot.api.setMyCommands([
    { command: 'start', description: 'How to use this bot' },
    { command: 'help', description: 'What I can download, and the limits' },
    { command: 'clip', description: 'Reply to a video: /clip (or /c) 0:05-0:15 cuts that part' },
    { command: 'frame', description: 'Reply to a video: /frame (or /f) for screenshots, /frame 0:12 for one moment' },
    { command: 'file', description: 'Reply to a photo/video/album I sent: the originals as files' },
    { command: 'sticker', description: 'Reply to a photo: turns it into a sticker' },
    { command: 'pdf', description: 'Reply to a photo or album: one PDF of its photos' },
    { command: 'stats', description: 'Bandwidth used this month and bot activity — owner only' },
    { command: 'chatid', description: 'Show this chat’s (and topic’s) ID — owner only' },
  ]);
} catch (err) {
  if (err?.error_code === 401 || err?.error_code === 404) {
    console.error('Telegram rejected BOT_TOKEN. Copy the token from @BotFather again into .env.');
    process.exit(1);
  }
  throw err;
}

const logStarted = (me, mode) =>
  console.log(
    `@${me.username} is running (${mode}). Open https://t.me/${me.username} and send it an Instagram, Facebook, Reddit, Snapchat, X or Threads link.` +
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
