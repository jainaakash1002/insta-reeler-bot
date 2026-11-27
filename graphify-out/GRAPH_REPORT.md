# Graph Report - src + yt-dlp-plugins

## Corpus Check
- Corpus: 10 files · ~25,284 words. AST-free extraction, no token cost.

## Summary
- 379 nodes · 1058 edges · 24 communities detected
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 0 edges (avg confidence: 0)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Bot Config & Access Control|Bot Config & Access Control]]
- [[_COMMUNITY_Download Cache|Download Cache]]
- [[_COMMUNITY_Captions Loader & Album Sending|Captions, Loader & Album Sending]]
- [[_COMMUNITY_Error Messages|Error Messages]]
- [[_COMMUNITY_start help chatid|/start, /help, /chatid]]
- [[_COMMUNITY_clip & Finding a Videos Post|/clip & Finding a Video's Post]]
- [[_COMMUNITY_frame|/frame]]
- [[_COMMUNITY_file|/file]]
- [[_COMMUNITY_sticker & Sticker Packs|/sticker & Sticker Packs]]
- [[_COMMUNITY_pdf (Photos to PDF)|/pdf (Photos to PDF)]]
- [[_COMMUNITY_stats (Bandwidth & Activity)|/stats (Bandwidth & Activity)]]
- [[_COMMUNITY_Re-sending Photos & Videos|Re-sending Photos & Videos]]
- [[_COMMUNITY_Links to Downloads (Request Flow)|Links to Downloads (Request Flow)]]
- [[_COMMUNITY_Screenshot Buttons|Screenshot Buttons]]
- [[_COMMUNITY_Startup & Webhook Server|Startup & Webhook Server]]
- [[_COMMUNITY_Facebook|Facebook]]
- [[_COMMUNITY_ffmpeg (Frames Clips Stickers)|ffmpeg (Frames, Clips, Stickers)]]
- [[_COMMUNITY_Instagram Keys & yt-dlp|Instagram, Keys & yt-dlp]]
- [[_COMMUNITY_PDF Writer|PDF Writer]]
- [[_COMMUNITY_Reddit|Reddit]]
- [[_COMMUNITY_Snapchat|Snapchat]]
- [[_COMMUNITY_Threads|Threads]]
- [[_COMMUNITY_X (Twitter)|X (Twitter)]]
- [[_COMMUNITY_yt-dlp Instagram Plugin|yt-dlp Instagram Plugin]]

## God Nodes (most connected - your core abstractions)
1. `bot` - 26 edges  (src/bot.js:L75)
2. `parseFacebookLink()` - 20 edges  (src/facebook.js:L270)
3. `describeError()` - 18 edges  (src/bot.js:L418)
4. `sendMedia()` - 17 edges  (src/bot.js:L1463)
5. `bot.on('message:text')` - 15 edges  (src/bot.js:L1424)
6. `makePdf()` - 15 edges  (src/bot.js:L1139)
7. `deliver()` - 14 edges  (src/bot.js:L1505)
8. `sendFrames()` - 14 edges  (src/bot.js:L832)
9. `postOfMessage()` - 13 edges  (src/bot.js:L703)
10. `parseSnapchatLink()` - 13 edges  (src/snapchat.js:L219)
11. `bandwidthLines()` - 12 edges  (src/bot.js:L1229)
12. `buildCaption()` - 12 edges  (src/bot.js:L264)

## Hub Files (most connected modules)
1. `src/bot.js` - 983 edges
2. `src/frames.js` - 172 edges
3. `src/facebook.js` - 170 edges
4. `src/instagram.js` - 160 edges
5. `src/reddit.js` - 158 edges
6. `src/snapchat.js` - 152 edges
7. `src/threads.js` - 125 edges
8. `src/x.js` - 107 edges
9. `src/pdf.js` - 26 edges
10. `yt-dlp-plugins/instagram-photos/yt_dlp_plugins/extractor/instagram_photos.py` - 21 edges

## Telegram Handlers (entry points)
- `bot.command(['start', 'help'])` (L597) -> `deleteCommand()`, `helpText()`
- `bot.command('chatid')` (L603) -> `deleteCommand()`, `escapeHtml()`, `isOwner()`, `topicOf()`
- `bot.command(['clip', 'c'])` (L754) -> `mayScreenshot()`, `parseTime()`, `sendClip()`, `videoIn()`
- `bot.command(['frame', 'f'])` (L816) -> `parseTime()`, `sendFrames()`, `videoIn()`
- `bot.command('file')` (L882) -> `isReddit()`, `mayUseReddit`, `postOfMessage()`, `sendFiles()`, `videoIn()`
- `bot.command('sticker')` (L966) -> `imageIn()`, `sendSticker()`, `stickerEmoji()`
- `bot.callbackQuery(STICKER_PACK_DATA)` (L1003) -> `packName()`
- `bot.command('pdf')` (L1076) -> `makePdf()`, `ownerOfPost()`, `pdfFileName()`, `pdfPageOf()`, `postOfMessage()`, `schedulePdfAlbum()`
- `bot.on('message:document')` (L1183) -> `takeForPdf()`
- `bot.command('stats')` (L1317) -> `bandwidthLines()`, `cacheSize()`, `deleteCommand()`, `escapeHtml()`, `formatMb()`, `isOwner()`, `resourceLines()`
- `bot.on(['message:photo', 'message:video'])` (L1355) -> `resendMedia()`, `takeForPdf()`, `topicOf()`
- `bot.on('message:text')` (L1424) -> `isReddit()`, `mayUseReddit`, `needsLogin()`, `parseFacebookLink()`, `parseInstagramLink()`, `parseRedditLink()`, `parseSnapchatLink()`, `parseThreadsLink()`, `parseXLink()`, `replyUnsupportedSite()`, `sendMedia()`
- `bot.callbackQuery(SCREENSHOT_DATA)` (L1626) -> `isReddit()`, `mayScreenshot()`, `mayUseReddit`, `requestFor()`, `sendScreenshots()`
- `bot.callbackQuery(DISMISS_DATA)` (L1641) -> `mayScreenshot()`
- `bot.callbackQuery(new)` (L1649) -> `applyButtonCleanup()`, `mayScreenshot()`, `planButtonCleanup()`
- `bot.callbackQuery(CLOSE_DATA)` (L1657) -> (inline)
- `bot.on('callback_query:data')` (L1663) -> (inline)
- `bot.catch()` (L1709) -> (inline)

## External Dependencies (most imported)
- `node:fs` - 6 import sites
- `node:fs/promises` - 6 import sites
- `node:path` - 6 import sites
- `node:stream` - 4 import sites
- `node:stream/promises` - 4 import sites
- `node:os` - 3 import sites
- `node:child_process` - 2 import sites
- `node:crypto` - 2 import sites
- `node:https` - 2 import sites
- `node:util` - 2 import sites
- `grammy` - 1 import site
- `json` - 1 import site

## Surprising Connections (you probably didn't know these)
- `bot.callbackQuery(SCREENSHOT_DATA)` --calls--> `requestFor()`  [EXTRACTED]
  src/bot.js → src/instagram.js
- `bot.on('message:text')` --calls--> `parseFacebookLink()`  [EXTRACTED]
  src/bot.js → src/facebook.js
- `bot.on('message:text')` --calls--> `parseRedditLink()`  [EXTRACTED]
  src/bot.js → src/reddit.js
- `bot.on('message:text')` --calls--> `parseSnapchatLink()`  [EXTRACTED]
  src/bot.js → src/snapchat.js
- `bot.on('message:text')` --calls--> `parseThreadsLink()`  [EXTRACTED]
  src/bot.js → src/threads.js
- `bot.on('message:text')` --calls--> `parseXLink()`  [EXTRACTED]
  src/bot.js → src/x.js
- `describeError()` --calls--> `needsLogin()`  [EXTRACTED]
  src/bot.js → src/instagram.js
- `loadOrDownload()` --calls--> `ensureH264()`  [EXTRACTED]
  src/bot.js → src/frames.js

## Layer Boundary Crossings
Edges that cross a boundary the conventions in CLAUDE.md discourage (site modules, instagram.js, frames.js and pdf.js
have no Telegram dependency; site modules don't import each other; subprocesses only in instagram.js/frames.js):
- none

## Communities

### Community 0 - "Bot Config & Access Control"
Cohesion: 0.07
Nodes (38): bot.js, bot, mayScreenshot(), mayUseReddit, node:fs, node:fs/promises, node:path, OWNER_USERS (+30 more)

### Community 1 - "Download Cache"
Cohesion: 0.5
Nodes (4): getMedia(), loadOrDownload(), pruneCache(), inFlight

### Community 2 - "Captions, Loader & Album Sending"
Cohesion: 0.08
Nodes (22): buildCaption(), startLoader(), siteOf(), isReddit(), sendAlbums(), escapeHtml(), screenshotKeyboard(), siteName() (+14 more)

### Community 3 - "Error Messages"
Cohesion: 0.0
Nodes (1): describeError()

### Community 4 - "/start, /help, /chatid"
Cohesion: 0.33
Nodes (3): bot.command('chatid'), helpText(), bot.command(['start', 'help'])

### Community 5 - "/clip & Finding a Video's Post"
Cohesion: 0.1
Nodes (21): postOfMessage(), videoSource(), sendClip(), bot.command(['clip', 'c']), deleteCommand(), clipError(), downloadFromTelegram(), keyOfBotVideo() (+13 more)

### Community 6 - "/frame"
Cohesion: 0.5
Nodes (5): sendFrames(), bot.command(['frame', 'f']), FRAME_USAGE, FRAME_MAX, FRAME_TIME

### Community 7 - "/file"
Cohesion: 0.67
Nodes (3): sendFiles(), bot.command('file'), FILE_USAGE

### Community 8 - "/sticker & Sticker Packs"
Cohesion: 0.25
Nodes (9): bot.command('sticker'), sendSticker(), bot.callbackQuery(STICKER_PACK_DATA), imageIn(), packName(), STICKER_EMOJI, STICKER_PACK_DATA, stickerEmoji() (+1 more)

### Community 9 - "/pdf (Photos to PDF)"
Cohesion: 0.19
Nodes (14): makePdf(), bot.command('pdf'), rememberAlbum(), schedulePdfAlbum(), takeForPdf(), pdfPageOf(), pdfAlbums, bot.on('message:document') (+6 more)

### Community 10 - "/stats (Bandwidth & Activity)"
Cohesion: 0.18
Nodes (16): bandwidthLines(), bot.command('stats'), resourceLines(), countDownload(), formatMb(), renderBandwidth(), STATS_TIMEZONE, bar() (+8 more)

### Community 11 - "Re-sending Photos & Videos"
Cohesion: 0.5
Nodes (4): bot.on(['message:photo', 'message:video']), resendMedia(), COLLECT_MS, pendingMedia

### Community 12 - "Links to Downloads (Request Flow)"
Cohesion: 0.22
Nodes (9): sendMedia(), bot.on('message:text'), deliver(), alertFailure(), archiveCopy(), replyUnsupportedSite(), ALERT_EVERY_MS, EXPECTED_FAILURES (+1 more)

### Community 13 - "Screenshot Buttons"
Cohesion: 0.05
Nodes (7): bot.callbackQuery(SCREENSHOT_DATA), sendScreenshots(), bot.callbackQuery(new), bot.callbackQuery(DISMISS_DATA), bot.callbackQuery(CLOSE_DATA), bot.catch(), bot.on('callback_query:data')

### Community 14 - "Startup & Webhook Server"
Cohesion: 0.33
Nodes (3): logStarted(), startWebhook(), WEBHOOK_URL

### Community 15 - "Facebook"
Cohesion: 0.12
Nodes (37): facebook.js, parseFacebookLink(), downloadImage(), readFacebookPhoto(), readFacebookPost(), digits(), fetchPage(), postKeyFromPage() (+29 more)

### Community 16 - "ffmpeg (Frames, Clips, Stickers)"
Cohesion: 0.14
Nodes (33): frames.js, run, dropRepeats(), FFMPEG, makeSticker(), cutClip(), ensureH264(), extractFrames() (+25 more)

### Community 17 - "Instagram, Keys & yt-dlp"
Cohesion: 0.15
Nodes (28): instagram.js, downloadMedia(), requestFor(), runYtdlp(), parseInstagramLink(), needsLogin(), downloadPostItems(), downloadFacebookPhoto() (+20 more)

### Community 18 - "PDF Writer"
Cohesion: 0.6
Nodes (6): buildPdf(), pdf.js, embeddable(), jpegInfo(), A4, MARGIN

### Community 19 - "Reddit"
Cohesion: 0.17
Nodes (30): reddit.js, parseRedditLink(), downloadRedditFile(), getJson(), accessToken(), resolveRedditShareLink(), postItems(), readRedditPost() (+22 more)

### Community 20 - "Snapchat"
Cohesion: 0.15
Nodes (30): snapchat.js, parseSnapchatLink(), readSnapchat(), spotlightFromProfile(), downloadFile(), downloadSnapchat(), fetchPage(), resolveSnapchatShareLink() (+22 more)

### Community 21 - "Threads"
Cohesion: 0.19
Nodes (25): threads.js, queryPost(), downloadThreadsPost(), parseThreadsLink(), downloadFile(), threadsError(), BROWSER_UA, pickUrl() (+17 more)

### Community 22 - "X (Twitter)"
Cohesion: 0.2
Nodes (22): x.js, parseXLink(), downloadXPost(), downloadFile(), fetchPost(), pickUrl(), readPost(), resolveXShareLink() (+14 more)

### Community 23 - "yt-dlp Instagram Plugin"
Cohesion: 0.33
Nodes (9): instagram_photos.py, _add_photo_format(), _embedded_reels(), _InstagramStoryPhotosIE, _find_keys(), _InstagramPhotosIE, json, re (+1 more)
