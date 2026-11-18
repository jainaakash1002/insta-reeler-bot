# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Telegram bot (Node, ESM, [grammY](https://grammy.dev)). A user sends an Instagram link and the bot sends back what's in it: reels, video and photo posts, carousels, stories and highlights. Every video gets a button that sends evenly spaced frames grabbed with `ffmpeg`. Downloads go through `yt-dlp`, plus a small yt-dlp plugin in this repo that adds photos and works around Instagram's broken stories API. There is no build step, no TypeScript and only one npm dependency (`grammy`).

## Commands

```sh
npm install
npm start          # node --env-file-if-exists=.env src/bot.js
npm run dev        # same, with --watch (restarts on file changes)
```

- Requires Node >= 22.9 (for `--env-file-if-exists`).
- Requires a recent `yt-dlp` (it must support `--plugin-dirs`), plus `ffmpeg` and `ffprobe`. They must be on `PATH` (`brew install yt-dlp ffmpeg`) or set through `YTDLP_PATH`, `FFMPEG_PATH` and `FFPROBE_PATH`.
- Config comes from `.env` (copy `.env.example`). `BOT_TOKEN` is required; the bot exits at startup if it is missing or Telegram rejects it.
- Stories and highlights need Instagram cookies (`IG_COOKIES_FROM_BROWSER` or `IG_COOKIES_FILE`). Reels and posts download anonymously.
- **The Instagram login is turned off for now (November 2026).** Instagram suspended the account behind the cookies. All code that uses them is commented out and tagged `COOKIES PAUSED`, in `src/instagram.js` (`cookieArgs`, the login routing in `downloadMedia`) and `src/bot.js` (the login checks and messages). Even if `.env` has cookies, nothing passes them to yt-dlp. Story and highlight links get the `STORIES_PAUSED` message, and `downloadMedia` throws `code: 'STORIES_PAUSED'` for story keys. To turn the login back on with cookies from a working account, search for `COOKIES PAUSED`, restore the commented code and remove the paused lines next to it.
- There are **no tests, linter or formatter**. To check changes without Telegram:
  - Syntax: `for f in src/*.js; do node --check "$f"; done`
  - Link parsing: `node -e "import('./src/instagram.js').then(m => console.log(m.parseInstagramLink('https://www.instagram.com/reel/ABC123xyz/')))"`
  - `src/instagram.js` and `src/frames.js` have no Telegram dependency and can be imported and called directly, e.g. `downloadMedia('p-<shortcode>', dir)`. `src/bot.js` can't: it starts polling as soon as it is imported (top-level await).
  - To test `yt-dlp` and the plugin directly: `yt-dlp --plugin-dirs ./yt-dlp-plugins -v …`. The verbose output should list `Extractor Plugins: photos (InstagramIE), photos (InstagramStoryIE)`.
- End-to-end testing needs a real bot token. Run `npm run dev` and message the bot.

**On this machine the bot already runs as a launchd agent** (`~/Library/LaunchAgents/local.insta-reel-bot.plist`, label `local.insta-reel-bot`). It runs `node --watch`, so saving `.env` or any file `src/bot.js` imports restarts it. Don't run `npm start` or `npm run dev` while it is loaded: Telegram allows only one poller per token, and the second one fails with `409 Conflict`.
- Logs: `tail -f ~/Library/Logs/insta-reel-bot.log`
- Restart by hand: `launchctl kickstart -k gui/$(id -u)/local.insta-reel-bot`
- Stop until the next login: `launchctl bootout gui/$(id -u)/local.insta-reel-bot`. Start again: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.insta-reel-bot.plist`
- The plugin needs no restart, because each `yt-dlp` run loads it fresh.

## Architecture

The code is split into four parts:
- `src/bot.js`: Telegram handlers, the download cache, captions and album sending.
- `src/instagram.js`: link parsing, share-link resolution and running `yt-dlp`.
- `src/frames.js`: `ffprobe` and `ffmpeg`.
- `yt-dlp-plugins/`: the yt-dlp plugin.

**Keys.** Everything downloadable is identified by a key string. The key is the cache folder name and travels in screenshot-button callback data. `KEY_TYPES` in `instagram.js` defines the formats:

| Key | What it downloads |
| --- | --- |
| `p-<shortcode>` | A post, reel or carousel |
| `s-<user>-<pk>` | One story |
| `u-<user>` | All of a user's current stories |
| `h-<id>` | A whole highlight |
| `h-<id>-<pk>` | One item of a highlight |

`requestFor(key)` validates a key and rebuilds the canonical URL and the extra yt-dlp arguments from it. A single story needs `--no-playlist`, or yt-dlp downloads all of the user's stories. A single highlight item uses `--match-filters id='<pk in base64>'`. Keys use only `[\w.-]`, because callback data is limited to 64 bytes: `s1:<item n>:<key>` (one screenshot) or `ss:<item n>:<key>` (all `SCREENSHOT_COUNT`), matched by `SCREENSHOT_DATA`.

**Link parsing.** `parseInstagramLink` takes the first instagram.com or instagr.am link in a message and returns one of:
- `{ key }` for something downloadable.
- `{ share: url }` for `/share/…` links. `resolveShareLink` follows their HTTP redirects with `fetch` and parses the destination.
- `{ unsupported: true }` for profiles, audio pages and similar.

`/s/<base64>` links decode to `highlight:<id>`. The `story_media_id` query parameter selects one item.

**Security invariant.** User text never reaches a subprocess. Only validated parts (shortcode `[\w-]+`, username `\w[\w.]*`, numeric IDs) go into keys, and `requestFor` builds the URL from the key. Subprocesses use `execFile` (no shell), and the URL comes after `--`. The callback-query regex and `requestFor` validate keys again when a button is pressed. Keep all of this intact when changing parsing or download code.

**yt-dlp contract (`downloadMedia`).**
- A single call downloads every item into `<dir>/<id>.<ext>`. `--print after_move:%(.{ITEM_FIELDS})j` prints one JSON line per item. To use a new yt-dlp field, add it to `ITEM_FIELDS`.
- A non-zero exit, or the 10-minute timeout, with some JSON already printed means some items failed. The ones that finished are kept, and the result is marked `partial: true`. `deliver` then tells the user that some items are missing.
- Zero items throws an error with `code: 'NO_MEDIA'` (for example, an expired story).
- An item is a photo or a video depending on its file extension.
- **When the login is used.** Stories and highlights always run with the cookies (`cookieArgs`). Posts and reels run without them first, and `runYtdlp` retries with them only if that fails (for example, a private account). The reason: as of November 2026 Instagram answers yt-dlp's logged-in post request with HTTP 400, while the anonymous one works. When both runs fail, the anonymous run's error is thrown and the login run's error is logged.
- **A dead login looks like an Instagram error.** If the cookies' account is suspended or logged out, posts fail with `HTTP Error 400` when the login is used, and stories fail with "This content is unreachable". To check the session, request `https://www.instagram.com/accounts/edit/` with the cookies: a 200 means logged in; a redirect to `/accounts/login/` or `/accounts/suspended/` means the cookies are dead.

**The yt-dlp plugin** (`yt-dlp-plugins/instagram-photos/yt_dlp_plugins/extractor/instagram_photos.py`). It uses yt-dlp's `plugin_name=` override mechanism on `InstagramIE` and `InstagramStoryIE` and makes two fixes:
- **Photos.** yt-dlp's Instagram extractors return only videos, and its story extractor drops photo items. The plugin wraps `_extract_product_media`: when an item has no video formats, it adds one `photo` format (the largest image candidate). The bot's format selector ends in `/photo` so that format gets picked.
- **Stories.** yt-dlp loads the story page, then calls `/api/v1/feed/reels_media/`. As of November 2026 Instagram answers that call with HTTP 500, so yt-dlp reports a misleading "You need to log in". The logged-in story page already embeds the same data. The plugin wraps `_download_webpage` to remember the page, and wraps `_download_json` to answer an empty `reels_media` result from that page, so yt-dlp's own story logic (single item, highlights, `_extract_product`) runs unchanged. The data is under `xdt_api__v1__feed__reels_media.reels_media[]` for a user's stories and `xdt_api__v1__feed__reels_media__connection.edges[].node` for highlights. Highlight items lack `user.username`, so the reel's `user` is merged into each item. If Instagram fixes the endpoint, the API result wins again automatically.

This depends on yt-dlp internals and Instagram's page format. If photos or stories stop working after an update, check that `_extract_product_media` still exists in `yt_dlp/extractor/instagram.py`, and save the story page to look at it: `yt-dlp --write-pages --cookies … <story url>` writes it to a `.dump` file in the current directory. To debug requests, use `--print-traffic`, but filter out cookie and token headers before showing the output to anyone. `--plugin-dirs` points at the folder *containing* plugin packages (`yt-dlp-plugins/`), not at `yt_dlp_plugins/` itself.

**Request flow.** A text message is parsed, then `sendMedia` resolves share links and checks for a login on story keys. It then calls `getMedia(key)` and `deliver`:
- **One item:** sent as a single photo or video, with the caption and, for a video, the screenshot button.
- **Several items:** sent as albums of up to 10, with the caption on the first item. A chunk with a single item is sent on its own, because Telegram albums need at least 2 items. A follow-up message lists skipped oversize items (over 50 MB for a video, 10 MB for a photo) and carries the screenshot buttons, one row per video.

Videos in stories and highlights (`needsLogin(key)`) get two buttons: **1 screenshot** (`s1:`, one frame from the middle) and **all N** (`ss:`). Reels and posts get only the **N screenshots** button (`ss:`). The handler calls `getMedia` again, runs `extractFrames` on item `n`, then `dropRepeats`. `dropRepeats` compares 32×32 grayscale versions of the frames and drops any frame that looks like the previous kept one; the threshold was measured on real videos (see `frames.js`). After any screenshot request, `planButtonCleanup`/`applyButtonCleanup` clean up the pressed message: **1 screenshot** deletes the whole message (even the video itself); **all N** removes that video's buttons, and deletes the message only if it is a text message with no buttons left.

**Screenshots (`frames.js`).** Two things went wrong here before:
- **Color range.** Recent ffmpeg (9.x) refuses to write limited-range ("tv") frames as JPEG, which is most videos. The fix is `-vf scale=out_range=full -strict unofficial`; don't drop either part.
- **Missing frames.** Some Instagram videos are 1-fps slideshows made from photo stories. When no frame starts after the requested time (usually the last slice), ffmpeg exits 0 and writes nothing. `grabFrame` checks that the file exists and retries at the start of the slice. Frames that still fail are skipped, and only an empty result throws.

**Error messages.** Errors carry a `source` (`'yt-dlp'` from `downloadMedia`, `'ffmpeg'` from `extractFrames`). `describeError` only blames Instagram (expired story, login, private post) for `source: 'yt-dlp'`. "Not installed" is reserved for `ENOENT` from a spawn, not from a missing file.

**Re-sending media.** A photo or video message sent or forwarded to the bot is sent back by `file_id` (the largest photo size), with no caption. Telegram reuses the file, so nothing is downloaded or uploaded. Photos and videos from the same chat are collected for `COLLECT_MS` (1.5 s after the last one) in `pendingMedia`, then `resendMedia` sends them in the order sent, as albums of up to 10. After every album is sent, it deletes the originals with `deleteMessages`; if a send fails, they stay.

**Cleaning up the user's link.** `deliver` returns true when every item was sent. `sendMedia` then deletes the user's link message (bots may delete incoming messages in private chats; in groups this needs admin rights and fails silently). After an error, a partial download or a skipped oversize item, the link message stays.

**Handlers are fire-and-forget on purpose.** `sendMedia` and `sendScreenshots` are started without `await`, so grammY's sequential update processing isn't blocked by a long download. Each one catches its own errors and reports them in the chat through `describeError(err, key)`.

**Rate limiting.** A grammY API transformer retries any call that gets a 429 response, waiting `retry_after` each time, up to 3 attempts. Sending many albums of stories in a row triggers this.

**Download cache (`getMedia` / `loadOrDownload` / `pruneCache`):**
- On disk at `os.tmpdir()/insta-reel-bot/<key>/`, holding the item files and a `meta.json` (`{ author, description, partial, items: [{ file, kind, width, height, duration, size }] }`).
- `inFlight` dedupes concurrent requests for the same key.
- The TTL (1 h) is based on the directory mtime, which a cache hit refreshes. The pruner skips in-flight keys.
- To test edge cases (oversize items, more than 10 items) without Instagram, edit or write a cached `meta.json`.

**Other Telegram limits in `bot.js`:**
- Captions are deliberately short: `👤 @username` linking to the profile (`media.username`, from yt-dlp's `channel`), then `🔗 Open on Instagram` linking to the post or story. The post's own text isn't included.
- Captions use `parse_mode: 'HTML'`, so every interpolated value must go through `escapeHtml`.
- 100 buttons per inline keyboard.

**Access control.** The first middleware allows everyone when `ALLOWED_USER_IDS` is empty, and otherwise only the listed numeric user IDs. `/start` replies with the sender's user ID so the owner can find theirs.

## Repo note

This directory is its own git repository. Its remote, `origin`, is `https://github.com/jainaakash1002/insta-reeler-bot` (public). Pushes go over HTTPS as the GitHub account `imaakashjain`, which is a collaborator on that repo, using the login saved in the macOS Keychain.

- Commits use a repo-local identity whose email is `imaakashjain`'s GitHub noreply address. Don't commit with the global git email, a work address, or the repo history will show it publicly.
- The home directory is a separate git repository (remote `imaakashjain/nexus`). If `git rev-parse --show-toplevel` ever prints the home directory instead of this folder, stop: a commit would land in the wrong repository.
- The repo is public, so never commit `.env`, cookie files or tokens.
