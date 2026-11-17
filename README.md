# insta-reel-bot

A Telegram bot. Send it an Instagram link and it replies in the chat with what's in it, plus the author and caption:

| You send | You get |
| --- | --- |
| Reel or video post | The video, playable in Telegram |
| Photo post | The photo |
| Carousel | All of its photos and videos, as albums of up to 10 |
| Story (`instagram.com/stories/user/123…`) | That story |
| A user's stories (`instagram.com/stories/user/`) | All of their current stories |
| Highlight | The whole highlight, or just the item you shared |
| Share link (`instagram.com/share/…`) | Whatever it points to |

Every video gets a **📸 Get screenshots** button that sends evenly spaced full-resolution frames as an album.

**Stories and highlights need an Instagram login** (see [Stories and highlights](#stories-and-highlights)). Reels and posts work without one.

It's written in Node with [grammY](https://grammy.dev). [yt-dlp](https://github.com/yt-dlp/yt-dlp) downloads from Instagram, with a small plugin in `yt-dlp-plugins/` that adds photos (yt-dlp on its own only downloads videos). ffmpeg grabs the frames.

## Setup

1. **Install the tools** (once):
   ```sh
   brew install yt-dlp ffmpeg
   ```
   If yt-dlp is already installed, update it (`brew upgrade yt-dlp`): the bot needs a recent version.
2. **Create the bot in Telegram**: message [@BotFather](https://t.me/BotFather), send `/newbot`, choose a name and a username, and copy the token it gives you.
3. **Configure**:
   ```sh
   cp .env.example .env
   # paste the token after BOT_TOKEN=
   ```
4. **Run**:
   ```sh
   npm install
   npm start
   ```
5. In Telegram, open your bot, send `/start`, then paste an Instagram link.

### Make it private (recommended)

Out of the box, anyone who finds your bot can use it, and every download runs on your machine. To lock it down, send `/start` to the bot, copy the user ID it shows you, and put it in `.env`:

```
ALLOWED_USER_IDS=123456789
```

Separate several IDs with commas. Restart the bot after changing `.env`.

## Settings (`.env`)

| Variable | Default | What it does |
| --- | --- | --- |
| `BOT_TOKEN` | — | **Required.** Token from @BotFather. |
| `ALLOWED_USER_IDS` | empty (everyone) | Comma-separated Telegram user IDs allowed to use the bot. |
| `SCREENSHOT_COUNT` | `6` | Frames sent per screenshot request (1–10, the max for a Telegram album). |
| `IG_COOKIES_FROM_BROWSER` | — | `chrome`, `firefox`, `brave`, `edge` or `safari`. Uses that browser's Instagram login. Needed for stories and highlights. |
| `IG_COOKIES_FILE` | — | Path to a `cookies.txt` exported from a browser logged into Instagram. |
| `YTDLP_PATH`, `FFMPEG_PATH`, `FFPROBE_PATH` | on `PATH` | Only if the tools are installed somewhere unusual. |

## Stories and highlights

Instagram only shows stories and highlights to logged-in users, so the bot needs an Instagram login for them. Until one is set up, it replies with instructions instead.

1. Log in to Instagram in a browser on the machine that runs the bot. Use a secondary account, because automated downloads can get an account flagged.
2. Put that browser in `.env`, for example `IG_COOKIES_FROM_BROWSER=chrome`, and restart the bot. (Or export a `cookies.txt` and set `IG_COOKIES_FILE`.)

Stories of private accounts only work if that account follows them. Stories disappear after 24 hours, so old story links stop working.

## When Instagram refuses downloads

Public reels usually download without logging in. Instagram rate-limits anonymous requests, though, so after heavy use (or from a server IP) you may see *"Instagram didn't return this post"*. In that case:

1. **Update yt-dlp first.** Instagram changes often and yt-dlp keeps up: `brew upgrade yt-dlp`
2. **Give it a login.** Set `IG_COOKIES_FROM_BROWSER=chrome` (or another browser) in `.env`. Use a secondary Instagram account, because automated downloads can get an account flagged. On macOS, Chrome asks for Keychain access the first time. Safari needs Full Disk Access for your terminal.

Private posts only work if the account whose cookies you use can see them.

## Limits

- **Profile links, audio pages and other Instagram pages aren't supported.** Send a link to a reel, post, story or highlight.
- **50 MB per video and 10 MB per photo**, the Bot API's upload limits. Reels are almost always well under them. If an item isn't, the bot says so, sends the rest and still offers screenshots.
- **Share links (`/share/…`) depend on Instagram redirecting them.** If one fails, open it in a browser and send the `instagram.com/…` link it lands on.
- **Photos are the largest size Instagram offers** to whoever downloads them, which is sometimes smaller without a login.
- **It runs only while `npm start` is running.** To keep it up around the clock, run it on a server (any Linux box with Node 22+, yt-dlp and ffmpeg) or under `pm2`.
- Downloads are cached in your system temp folder for an hour, so the screenshot button doesn't download them again. (This also means a user's stories are an hour old at most when you ask again.)

Only download content you have the right to use.

## Files

```
src/bot.js        Telegram handlers, caching, captions, albums
src/instagram.js  link parsing, share links, yt-dlp download
src/frames.js     ffmpeg screenshot extraction
yt-dlp-plugins/   yt-dlp plugin that adds Instagram photos
```
