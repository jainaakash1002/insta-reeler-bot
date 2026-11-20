# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Telegram bot (Node, ESM, [grammY](https://grammy.dev)). A user sends an Instagram link and the bot sends back what's in it: reels, video and photo posts, carousels, stories and highlights. Public Facebook videos, reels, posts (photos and videos) and single photos work too, and so do Reddit posts (videos, images, GIFs, galleries) through Reddit's API public Snapchat Spotlight videos, stories and highlights, and public X (Twitter) posts (photos, videos, GIFs). Every video gets a button that sends evenly spaced frames grabbed with `ffmpeg`. Downloads go through `yt-dlp`, plus a small yt-dlp plugin in this repo that adds photos and works around Instagram's broken stories API. There is no build step, no TypeScript and only one npm dependency (`grammy`).

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
- **Webhook mode** (`WEBHOOK_URL`, for hosts that sleep when idle, like Render's free Web Service): `startWebhook` in `bot.js` serves `POST /telegram` on `PORT` (default 3000), checks Telegram's `X-Telegram-Bot-Api-Secret-Token` (sha256 of `webhook:<token>`, so nothing extra to configure), answers 200 at once and then runs `bot.handleUpdate` (an error reply would make Telegram resend the update). Every other request gets `ok` (health check). It calls `setWebhook` at startup. Without `WEBHOOK_URL` the bot long-polls; grammY's `bot.start()` deletes the webhook, so a local `npm start` breaks the hosted bot until it restarts. `Dockerfile` builds the image for Render/Railway/a VPS (see README).

## Architecture

The code is split into four parts:
- `src/bot.js`: Telegram handlers, the download cache, captions and album sending.
- `src/instagram.js`: Instagram link parsing, `KEY_TYPES`/`requestFor` for every site, share-link resolution and running `yt-dlp`.
- `src/facebook.js`: Facebook link parsing, share-link resolution, and reading post and photo pages (photos are downloaded here, without yt-dlp).
- `src/snapchat.js`: Snapchat link parsing, reading the public pages and downloading their media.
- `src/x.js`: X (Twitter) link parsing, `t.co` resolution, reading a post from the syndication API and downloading its files.
- `src/reddit.js`: Reddit link parsing, share-link resolution, the API token, reading a post's media and downloading images/MP4s.
- `src/frames.js`: `ffprobe` and `ffmpeg` (screenshots and `ensureH264`).
- `yt-dlp-plugins/`: the yt-dlp plugin.

**Keys.** Everything downloadable is identified by a key string. The key is the cache folder name and travels in screenshot-button callback data. `KEY_TYPES` in `instagram.js` defines the formats:

| Key | What it downloads |
| --- | --- |
| `p-<shortcode>` | A post, reel or carousel |
| `s-<user>-<pk>` | One story |
| `u-<user>` | All of a user's current stories |
| `h-<id>` | A whole highlight |
| `h-<id>-<pk>` | One item of a highlight |
| `f-<video id>` | A Facebook video or reel (`site: 'facebook'`) |
| `fp-<page>-<post id>` | A Facebook post: photos and/or videos (page is a numeric id or username) |
| `fph-<photo id>` | One Facebook photo (`photo.php?fbid=`) |
| `r-<post id>` | A Reddit post (base36 id, lowercased; `site: 'reddit'`) |
| `scu-<user>` | A Snapchat user's current public story |
| `sch-<user>-<uuid>` | One Snapchat highlight |
| `scs-<16-char hash>` | A Snapchat Spotlight video (the id is looked up, see below) |
| `scn-<user>-<16-char hash>` | One snap of a Snapchat user's story (the snap id is looked up the same way) |
| `x-<post id>` | An X (Twitter) post (`site: 'x'`) |

`requestFor(key)` validates a key and rebuilds the canonical URL and the extra yt-dlp arguments from it. A single story needs `--no-playlist`, or yt-dlp downloads all of the user's stories. A single highlight item uses `--match-filters id='<pk in base64>'`. Keys use only `[\w.-]`, because callback data is limited to 64 bytes: `s1:<item n>:<key>` (one screenshot) or `ss:<item n>:<key>` (all `SCREENSHOT_COUNT`), matched by `SCREENSHOT_DATA`.

**Link parsing.** `parseInstagramLink` takes the first instagram.com or instagr.am link in a message and returns one of:
- `{ key }` for something downloadable.
- `{ share: url }` for `/share/…` links. `resolveShareLink` follows their HTTP redirects with `fetch` and parses the destination.
- `{ unsupported: true }` for profiles, audio pages and similar.

`/s/<base64>` links decode to `highlight:<id>`. The `story_media_id` query parameter selects one item.

The text handler tries `parseInstagramLink` first, then `parseFacebookLink` (`src/facebook.js`), then `parseRedditLink` (`src/reddit.js`), then `parseSnapchatLink` (`src/snapchat.js`), then `parseXLink` (`src/x.js`). They return the same shapes with `site: 'facebook'`/`'reddit'`/`'snapchat'`/`'x'` on share and unsupported results. A message with none of these links gets no reply; text around a link is ignored.

**Facebook.**
- **Links.** Every video and reel link (`watch/?v=`, `watch/live/?v=`, `video.php?v=`, `reel/<id>`, `<page>/videos/[slug|vb.n/]<id>`) becomes `f-<numeric id>`. `requestFor` always rebuilds `https://www.facebook.com/watch/?v=<id>`, which yt-dlp handles for reels too.
- **Share links.** `fb.watch/<code>` and `facebook.com/share/[v|r|p/]<code>` go through `resolveFacebookShareLink`, a redirect loop like Instagram's `resolveShareLink`. It uses `node:https`, not `fetch`, because Facebook answers these links with HTTP 400 unless the request sends `Sec-Fetch-Mode: navigate`, and Node's `fetch` always overwrites that header with `cors`.
- **Posts.** `story.php`/`permalink.php?story_fbid=<n>&id=<n>` and `/<page>/posts/<n>` become `fp-<page>-<post>`, and the URL is rebuilt as `/<page>/posts/<post>/`. Many `share/…` links redirect to `story.php`. yt-dlp only downloads videos and can't parse some post pages, so `downloadFacebookPost` (`instagram.js`) first reads the logged-out post page with `readFacebookPost` (`facebook.js`):
  - **What it reads.** The page embeds JSON in `<script type="application/json">` tags. The post is the object under the key `node_v2` whose `post_id` matches. Its `attachments[].styles.attachment` has either `all_subattachments.nodes[].media` (several items, full image in `viewer_image.uri`) or `media` (one item: `photo_image.uri`, with the size in `viewer_image`). Only the post's own `node_v2` is used, because comments carry their own attachments deeper in the page. An earlier version scanned the whole page and sent a comment's video.
  - **A post with any photos** is built from the page: photos are fetched directly with `downloadImage` (`*.fbcdn.net` only), videos through yt-dlp as `f-<id>`.
  - **Other posts** go through yt-dlp, with the page's video ids as the fallback.
  - **Hidden items.** Logged out, Facebook lists only some of a big post's items (e.g. 5 of 6), and `all_subattachments.count` gives the real total. The result carries `hidden: <missing count>`, and `deliver` adds a note. The photo viewer can't reach the rest: logged out, its `nextMedia` walks the page's album, not the post.
- **`pfbid…` post links** are too long for callback data. They parse as `{ share, pfbid: true }`, and `resolveFacebookShareLink` reads the page for the numeric `post_id` and the actor id, giving `fp-<actor id>-<post id>`. The same happens for numeric posts under a page name too long for a key.
- **Single photos.** `photo.php?fbid=<n>`, `/photo/?fbid=<n>` and `/<page>/photos/<album>/<n>` become `fph-<n>`. `readFacebookPhoto` takes `currMedia.image` (full size) and the owner from `currMedia.container_story.actors`.
- `fetchPage` follows up to 3 redirects within `www.facebook.com`, for example a video post that redirects to `/<page>/videos/…`. Page-reading errors carry `source: 'facebook'`, which `describeError` treats like yt-dlp errors.
- **Unsupported.** Profiles, groups and private content.
- **Quality.** Downloads add `-S res:720`, so long videos stay under the 50 MB upload limit.
- **Codec.** Facebook often serves only VP9, which Telegram on iOS doesn't play inline. `loadOrDownload` runs `ensureH264` (`frames.js`) on Facebook videos before caching: it probes the codec, re-encodes to H.264 when needed, and keeps the original if that fails. Instagram videos are never touched.
- **Captions and errors.** `buildCaption` and `describeError` branch on `isFacebook(key)`. The caption is `👤 <page name>` linking to `facebook.com/<uploader_id>`, then `Open on Facebook`. Instagram's captions and messages are unchanged.
- **Downloader quirk.** Some Facebook videos fail inside yt-dlp with "Cannot parse data". That is a yt-dlp extractor issue; updating yt-dlp is the fix.

**Reddit.**
- **Access.** Reddit answers anonymous requests for post data with HTTP 403 from most networks (including this machine, November 2026). With `REDDIT_CLIENT_ID`/`REDDIT_CLIENT_SECRET` (a "script" app), `accessToken` gets an application-only token (`grant_type=client_credentials`, cached for its lifetime) and the post is read from `https://oauth.reddit.com/comments/<id>?raw_json=1`. Without them the public `.json` URL is tried; a 403/429 there throws `code: 'REDDIT_NEEDS_KEY'`, a rejected key `REDDIT_KEY_INVALID`. Reddit wants a descriptive `User-Agent` (`USER_AGENT`).
- **Links.** `/r/<sub>/comments/<id>`, `/user/<u>/comments/<id>`, `/comments/<id>` on any reddit.com subdomain, and `redd.it/<id>`, become `r-<id>`. `v.redd.it/<code>` and the app's `/r/<sub>/s/<code>` links are share links: `resolveRedditShareLink` follows their redirects (retrying on `oauth.reddit.com` with the token if www.reddit.com doesn't redirect).
- **Media** (`postItems`). Crossposts use `crosspost_parent_list[0]`. A gallery is `gallery_data.items` (order) + `media_metadata` (`e: 'Image'` → `https://i.redd.it/<media id>.<ext>` with `s.u` as fallback; `AnimatedImage` → `s.mp4`). A video is `secure_media.reddit_video`: its `dash_url` on v.redd.it goes to yt-dlp (generic DASH, `-S res:720`), which merges the separate video and audio. A GIF is the preview's `variants.mp4`; a converted external GIF is `preview.reddit_video_preview`. Images are `url` on i.redd.it or `preview.images[0].source`. Text posts throw `NO_MEDIA`, links elsewhere `EXTERNAL_LINK` (with `domain`).
- **Downloads.** `downloadRedditPost` (`instagram.js`) downloads in order: images and MP4s with `downloadRedditFile` (only `i.redd.it`, `preview.redd.it`, `external-preview.redd.it`, `v.redd.it`, image or mp4 content types), videos with `runYtdlp` and `request.output` naming the file. URLs from Reddit's data are host-checked before use. `loadOrDownload` runs `ensureH264` on every non-Instagram video.
- **Caption.** `👤 u/<author> in r/<sub>`, then `Open on Reddit` (`https://www.reddit.com/comments/<id>/`). Errors carry `source: 'reddit'`.

**Snapchat** (`snapchat.js`, no login).
- yt-dlp's `SnapchatSpotlight` extractor fails ("Unable to extract next.js data", November 2026), so the pages are read directly with `fetch` (redirects only within www.snapchat.com) and files are downloaded from `*.sc-cdn.net` (content type decides `.jpg`/`.mp4`).
- **Profile** (`/@user`, `/add/user`, `story.snapchat.com/@user`) → `scu-<user>`: `__NEXT_DATA__` `props.pageProps.story.snapList`; no snaps throws `NO_STORY`. **Highlight** (`/@user/highlight/<uuid>`) → `sch-<user>-<uuid>`: `pageProps.highlight.snapList`, owner in `publicUserProfile`. A snap: `snapMediaType` 0 photo / 1 video, `snapUrls.mediaUrl`. Overlays (`overlayUrl`) aren't added.
- **Spotlight** (`/spotlight/<id>`, `/@user/spotlight/<id>`): the page is App Router (no `__NEXT_DATA__`); the video is the `VideoObject` in `application/ld+json` (`contentUrl`, `creator.alternateName`/`name`). Ids are ~59 chars, too long for callback data, so the key is `scs-` + 16 chars of the id's SHA-256 (base64url), and `ID_FILE` (`os.tmpdir()/insta-reel-bot-snapchat-ids.json`) maps it back. `requestFor` returns null for an unknown hash (e.g. after the temp folder is cleared).
- **App share links** (`snapchat.com/t/<code>`) redirect (303) to `story.snapchat.com/u/<user>/<snap id>` (one story snap → `scn-`: the story page, keeping only the snap whose `snapId.value` matches; gone → `SNAP_GONE`) or `story.snapchat.com/o/<id>` (a Spotlight). Some Spotlight pages leave out their own video (only an "up next" list of other videos); `spotlightFromProfile` then looks for the id in the creator's `spotlightHighlights` (only the ~16 newest are on the page), else `SPOTLIGHT_HIDDEN`.
- Usernames are limited to 15 characters so `ss:<n>:sch-<user>-<uuid>` fits in 64 bytes. Short links (`t.snapchat.com/<code>`, `/t/<code>`) go through `resolveSnapchatShareLink`. Errors carry `source: 'snapchat'`.

**X (Twitter)** (`x.js`, no login, no API key).
- **Source.** `https://cdn.syndication.twimg.com/tweet-result?id=<id>&token=<t>`, X's embed API (yt-dlp isn't used). `token` is derived from the id (`tokenFor`, the formula X's embed code uses). Works anonymously from this machine (November 2026).
- **Links.** `/<user>/status/<id>`, `/i/status/<id>`, `/i/web/status/<id>`, `/statuses/<id>` on x.com, twitter.com (www/mobile/m) and the fxtwitter/vxtwitter/fixupx/fixvx mirrors become `x-<id>`; other x.com pages are unsupported. `t.co/<code>` is a share link: `resolveXShareLink` follows its 301 (it sends a curl User-Agent, because t.co answers browsers with an HTML page instead of a redirect).
- **Media.** `mediaDetails[]`: `photo` → `media_url_https` with `?name=orig`; `video`/`animated_gif` → `video_info.variants` MP4s (audio included), best bitrate first, and `pickUrl` HEADs them for the first ≤ 49 MB. A post without media uses `quoted_tweet`'s (and its author). Files only from `pbs.twimg.com`/`video.twimg.com`.
- **Errors.** 404 or an empty body → `X_GONE` (deleted or protected); `__typename: 'TweetTombstone'` → `X_HIDDEN` (sensitive, hidden logged out); 429 → `X_RATE_LIMIT`; no media → `NO_MEDIA`. Errors carry `source: 'x'`.
- **Caption.** `👤 Name (@user)` linking to `x.com/<user>`, then `Open on X`.

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

**Screenshots (`frames.js`).** Three things went wrong here before:
- **Memory.** All frames used to be grabbed by parallel ffmpegs, which got the bot killed without an error on Render's free 512 MB instance (log shows only `Instance … restarted`). `mapLimited` now runs at most `JOBS` at once: `FFMPEG_JOBS`, else 1 when the cgroup memory limit (`memoryLimit`) is under 1 GB, else 4. Frame grabs use `-threads 1`; in low-memory mode x264 does too. The startup log prints `ffmpegMode`.
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
