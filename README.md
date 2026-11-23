# insta-reel-bot

A Telegram bot. Send it an Instagram link and it replies in the chat with what's in it, with a short caption: the account (tap it to open the profile) and an **Open on Instagram** link to the post or story:

| You send | You get |
| --- | --- |
| Reel or video post | The video, playable in Telegram |
| Photo post | The photo |
| Carousel | All of its photos and videos, as albums of up to 10 |
| Story (`instagram.com/stories/user/123…`) | That story |
| A user's stories (`instagram.com/stories/user/`) | All of their current stories |
| Highlight | The whole highlight, or just the item you shared |
| Share link (`instagram.com/share/…`) | Whatever it points to |
| Facebook video or reel (`facebook.com/watch/?v=…`, `/reel/…`, `/<page>/videos/…`) | The video (at most 720p, converted to H.264 if needed so it plays on iPhones) |
| Facebook post (`/<page>/posts/…`, `story.php?…`, including `pfbid…` links) | All its photos and videos, as albums |
| Facebook photo (`photo.php?fbid=…`) | The photo |
| Facebook short or share link (`fb.watch/…`, `facebook.com/share/…`) | The video it points to |
| Snapchat Spotlight (`snapchat.com/spotlight/…`, `/@user/spotlight/…`) | The video |
| Snapchat profile (`snapchat.com/@user`, `/add/user`) | That user's current public story, all snaps |
| Snapchat highlight (`snapchat.com/@user/highlight/…`) | The whole highlight |
| X (Twitter) post (`x.com/<user>/status/…`, `twitter.com/…`, `t.co/…` links) | Its photos (full size), video or GIF (as a video), as albums |
| Threads post (`threads.com/@<user>/post/…`, `threads.net/…`, `/t/…` links) | Its photos and videos, as albums |
| Reddit post (`reddit.com/r/…/comments/…`, `redd.it/…`, `v.redd.it/…`, the app's `/s/…` share links) | Its video (with sound), image, GIF (as a video) or whole gallery |

Every video gets a **📸 Get N screenshots** button (N evenly spaced full-resolution frames as an album). Story and highlight videos also get **📸 1 screenshot** (one frame from the middle). Repeated frames are left out, so a "video" that is really a still picture, like a photo story with music, gives one screenshot. After **📸 1 screenshot** the message with the buttons is deleted; after the other button the buttons are removed.

Once everything from a link has been sent, the bot deletes your message with the link to keep the chat clean. If something went wrong, the link stays.

**Any photo or video you send or forward to the bot** comes back on its own: same file, no caption, no "Forwarded from" line. Several sent or forwarded together come back as one album (up to 10 per album). Once the copies are sent, the bot deletes the originals you sent or forwarded.

**Facebook:** public videos, reels, posts and photos, no login. Photos are read straight from Facebook's page, since yt-dlp only downloads videos. Logged out, Facebook shows only some photos of a big post, so the bot says when some are missing. The caption shows the page's name (tap it to open the page) and an **Open on Facebook** link.

**Snapchat:** public Spotlight videos, stories and highlights, no login. The bot reads snapchat.com's public pages (yt-dlp's Snapchat support is broken). Text and stickers drawn on a snap aren't included. Private snaps and friends' stories never appear on the web, so they can't be downloaded.

**X (Twitter):** public posts, no login. The bot reads X's public embed API, the one that shows posts embedded on other websites. For a video it picks the best quality that fits Telegram's 50 MB limit. A post with no media of its own gets its quoted post's media. The caption shows `Name (@user)` and an **Open on X** link.

**Threads:** public posts, no login. yt-dlp can't read Threads, so the bot asks Threads for the post the same way its website does (logged out). When Threads updates its site this can stop working until the bot is updated; Threads links then get *"Threads changed how its website loads posts"* and everything else keeps working. Text-only posts have nothing to download.

**Reddit** needs a logged-in Reddit account's cookies (see [Reddit](#reddit)). The caption shows `u/<author> in r/<subreddit>` and an **Open on Reddit** link.

**Stories and highlights need an Instagram login** (see [Stories and highlights](#stories-and-highlights)). Reels and posts work without one.

It's written in Node with [grammY](https://grammy.dev). [yt-dlp](https://github.com/yt-dlp/yt-dlp) downloads from Instagram, with a small plugin in `yt-dlp-plugins/` that adds photos (yt-dlp on its own only downloads videos) and works around Instagram's broken stories API. ffmpeg grabs the frames.

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
| `OWNER_USER_IDS` | empty (everyone) | Comma-separated Telegram user IDs of the bot's owner(s). Only they may download Reddit links (they go through your Reddit account; others get *"Reddit downloads are only available to the bot's owner."*) and use `/chatid`, and their downloads aren't copied to `ARCHIVE_CHAT_ID`. Old name: `REDDIT_USER_IDS`, still read when this isn't set. |
| `ARCHIVE_CHAT_ID` | empty (off) | A chat id (e.g. your private group: add the bot, send `/chatid@<bot username>` there) that gets a copy of everything other users download, after a line naming the user. Users in `OWNER_USER_IDS` aren't copied. |
| `SCREENSHOT_USER_IDS` | same as `OWNER_USER_IDS` | Comma-separated Telegram user IDs who get the screenshot buttons. Others get none, and their taps on someone else's are refused. `all`: everyone, even when Reddit is limited. |
| `REDDIT_COOKIES_FILE` | — | Path to a `cookies.txt` from a browser logged into Reddit. Needed for Reddit links (see [Reddit](#reddit)). |
| `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` | — | An old Reddit API key, if you have one (Reddit no longer issues them). |
| `WEBHOOK_URL` | empty (polling) | The bot's public `https://` address on a host like Render. Telegram then sends messages to it. See [Hosting on Render](#hosting-on-render). |
| `FFMPEG_JOBS` | `4`, or `1` under 1 GB of memory | How many ffmpeg processes make screenshots at once. Small hosts (Render's free 512 MB) run one at a time, detected automatically. |
| `PORT` | `3000` | Port for webhook mode. Render sets it itself. |
| `YTDLP_PATH`, `FFMPEG_PATH`, `FFPROBE_PATH` | on `PATH` | Only if the tools are installed somewhere unusual. |

## Hosting on Render

The repo has a `Dockerfile` (Node 22, ffmpeg, the latest yt-dlp). Two ways to run it on [Render](https://render.com):

**Free: Web Service + webhook.** A free Web Service sleeps after 15 minutes without web traffic, so the bot runs in webhook mode: Telegram sends each message to the service, which wakes it. The first message after a quiet spell takes 30–60 s; Telegram retries until the service is up, so nothing is lost.
1. **New + → Web Service**, pick this repo, Language **Docker**, branch `main`, instance type **Free**.
2. Environment variables: `BOT_TOKEN`, `ALLOWED_USER_IDS` (recommended), and `WEBHOOK_URL` = the service's address shown at the top of its page, e.g. `https://insta-reel-bot.onrender.com` (no path). Set `WEBHOOK_URL` after the first deploy if the address isn't known yet; saving it redeploys.
3. **Health Check Path**: `/` (anything other than `/telegram` answers `ok`).
4. The log should say `@<bot> is running (webhook, port 10000)`.

Free instances have 0.1 CPU, so H.264 conversion and screenshots are slow, and the 750 free hours a month are shared by all free services in the workspace (webhook mode only uses them while the bot is awake).

**Always on: Background Worker** (Starter, $7/month). Same settings, but no `WEBHOOK_URL`: the bot polls and answers instantly.

Only one copy of the bot can run per token. Running `npm start` locally switches the bot to polling and removes the webhook; afterwards, restart the Render service (**Manual Deploy → Restart service**) to set it again. To update yt-dlp, use **Manual Deploy → Clear build cache & deploy**. Instagram rate-limits server IPs more than home connections, so Instagram links may fail there while the other sites work.

## Stories and highlights

Instagram only shows stories and highlights to logged-in users, so the bot needs an Instagram login for them. Until one is set up, it replies with instructions instead.

1. Log in to Instagram in a browser on the machine that runs the bot. Use a secondary account, because automated downloads can get an account flagged.
2. Put that browser in `.env`, for example `IG_COOKIES_FROM_BROWSER=chrome` (or `edge`, `"chrome:Profile 2"`, …), and restart the bot.

**Or give the bot its own login with a cookies file.** This lets you log in and out of the account anywhere else without breaking the bot, and it also works on a server:

1. Install the **Get cookies.txt LOCALLY** extension (by kairi003, from the Chrome Web Store; it works in Edge too) and allow it in Incognito/InPrivate windows.
2. In an Incognito/InPrivate window, log in to the account on instagram.com, click the extension and choose **Export** (Netscape format). Don't use *Export All Cookies*.
3. Close the window **without logging out**, move the file to `cookies.txt` in this folder (it's git-ignored), and set `IG_COOKIES_FILE=/full/path/to/cookies.txt` in `.env`.

The login lasts until it expires (about a year), you change the password, you log out of all sessions, or Instagram flags the account. Then export a new file.

Stories of private accounts only work if that account follows them. Stories disappear after 24 hours, so old story links stop working.

## Reddit

Reddit blocks anonymous requests for post data from most networks (HTTP 403), and it stopped handing out API keys in November 2026. So the bot reads Reddit **as a logged-in account**, using that account's cookies:

1. Log in to Reddit in a browser with a **spare account** (Reddit can ban accounts used for automated downloads).
2. With the **Get cookies.txt LOCALLY** extension, open reddit.com and choose **Export** (Netscape format, this site only).
3. Save the file as `cookies-reddit.txt` in this folder (git-ignored, like every `cookies*.txt`) and set `REDDIT_COOKIES_FILE=/full/path/to/cookies-reddit.txt` in `.env`. On Render, upload it under **Environment → Secret Files** as `cookies-reddit.txt` and set `REDDIT_COOKIES_FILE=/etc/secrets/cookies-reddit.txt`.

The bot only reads posts; it never posts, votes or comments. To keep other people's links off your account, set `OWNER_USER_IDS` to your Telegram user ID. The login lasts until the cookies expire or the account logs out of all sessions; Reddit links then get *"The bot's Reddit login has expired"*, and you export a new file (the bot rereads it without a restart). Links to other sites (YouTube, …) and text posts have nothing to download.

If you have an old API key (a "script" app), `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` still work and take precedence.

## When Instagram refuses downloads

Public reels usually download without logging in. Instagram rate-limits anonymous requests, though, so after heavy use (or from a server IP) you may see *"Instagram didn't return this post"*. In that case:

1. **Update yt-dlp first.** Instagram changes often and yt-dlp keeps up: `brew upgrade yt-dlp`
2. **Give it a login.** Set `IG_COOKIES_FROM_BROWSER=chrome` (or another browser) in `.env`. Use a secondary Instagram account, because automated downloads can get an account flagged. On macOS, Chrome asks for Keychain access the first time. Safari needs Full Disk Access for your terminal.

Private posts only work if the account whose cookies you use can see them.

## Limits

- **Profile links, audio pages and other Instagram pages aren't supported.** Send a link to a reel, post, story or highlight.
- **50 MB per video and 10 MB per photo**, the Bot API's upload limits. Reels are almost always well under them. If an item isn't, the bot says so, sends the rest and still offers screenshots.
- **Facebook: public content only.** Profiles, groups and private posts aren't supported. A big post may come back with a few photos missing, because Facebook hides them from logged-out visitors. `fb.watch/…` and `facebook.com/share/…` links depend on Facebook redirecting them to the video; if one fails, open it in a browser and send the link of the video it shows.
- **X: public posts only.** Protected accounts, deleted posts and posts X marks as sensitive (hidden from logged-out visitors) can't be downloaded. Heavy use can get rate-limited by X for a few minutes.
- **Reddit: only media hosted on Reddit** (v.redd.it, i.redd.it, galleries). Posts linking to YouTube, Imgur pages and other sites aren't supported, except GIFs Reddit has converted itself.
- **Share links (`/share/…`) depend on Instagram redirecting them.** If one fails, open it in a browser and send the `instagram.com/…` link it lands on.
- **Photos are the largest size Instagram offers** to whoever downloads them, which is sometimes smaller without a login.
- **It runs only while `npm start` is running.** To keep it up around the clock, run it on a server (any Linux box with Node 22+, yt-dlp and ffmpeg) or under `pm2`.
- Downloads are cached in your system temp folder for an hour, so the screenshot button doesn't download them again. (This also means a user's stories are an hour old at most when you ask again.)

Only download content you have the right to use.

## Files

```
src/bot.js        Telegram handlers, caching, captions, albums
src/instagram.js  Instagram link parsing, share links, yt-dlp download (all sites)
src/facebook.js   Facebook link parsing, post and photo pages
src/reddit.js     Reddit link parsing, API access, post media
src/snapchat.js   Snapchat link parsing, Spotlight/story/highlight pages
src/x.js          X (Twitter) link parsing, embed API, photo/video download
src/threads.js    Threads link parsing, the website's post query, photo/video download
src/frames.js     ffmpeg screenshot extraction, H.264 conversion
yt-dlp-plugins/   yt-dlp plugin: Instagram photos + stories fix
```
