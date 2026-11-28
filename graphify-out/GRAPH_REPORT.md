# Graph Report - src + yt-dlp-plugins

## Corpus Check
- Corpus: 11 files · ~26,512 words. AST-free extraction, no token cost.

## Summary
- 394 nodes · 1124 edges · 26 communities detected
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
- [[_COMMUNITY_botjs inline mode|bot.js: inline mode]]
- [[_COMMUNITY_Screenshot Buttons|Screenshot Buttons]]
- [[_COMMUNITY_Startup & Webhook Server|Startup & Webhook Server]]
- [[_COMMUNITY_Facebook|Facebook]]
- [[_COMMUNITY_fileIdsjs|fileIds.js]]
- [[_COMMUNITY_ffmpeg (Frames Clips Stickers)|ffmpeg (Frames, Clips, Stickers)]]
- [[_COMMUNITY_Instagram Keys & yt-dlp|Instagram, Keys & yt-dlp]]
- [[_COMMUNITY_PDF Writer|PDF Writer]]
- [[_COMMUNITY_Reddit|Reddit]]
- [[_COMMUNITY_Snapchat|Snapchat]]
- [[_COMMUNITY_Threads|Threads]]
- [[_COMMUNITY_X (Twitter)|X (Twitter)]]
- [[_COMMUNITY_yt-dlp Instagram Plugin|yt-dlp Instagram Plugin]]

## God Nodes (most connected - your core abstractions)
1. `bot` - 29 edges  (src/bot.js:L76)
2. `parseFacebookLink()` - 21 edges  (src/facebook.js:L270)
3. `describeError()` - 19 edges  (src/bot.js:L421)
4. `sendMedia()` - 17 edges  (src/bot.js:L1466)
5. `deliver()` - 16 edges  (src/bot.js:L1508)
6. `bot.on('message:text')` - 15 edges  (src/bot.js:L1427)
7. `makePdf()` - 15 edges  (src/bot.js:L1142)
8. `sendFrames()` - 14 edges  (src/bot.js:L835)
9. `parseSnapchatLink()` - 14 edges  (src/snapchat.js:L219)
10. `buildCaption()` - 13 edges  (src/bot.js:L265)
11. `postOfMessage()` - 13 edges  (src/bot.js:L706)
12. `parseRedditLink()` - 13 edges  (src/reddit.js:L252)

## Hub Files (most connected modules)
1. `src/bot.js` - 1074 edges
2. `src/facebook.js` - 172 edges
3. `src/frames.js` - 172 edges
4. `src/instagram.js` - 164 edges
5. `src/reddit.js` - 160 edges
6. `src/snapchat.js` - 154 edges
7. `src/threads.js` - 127 edges
8. `src/x.js` - 109 edges
9. `src/fileIds.js` - 27 edges
10. `src/pdf.js` - 26 edges
11. `yt-dlp-plugins/instagram-photos/yt_dlp_plugins/extractor/instagram_photos.py` - 21 edges

## Telegram Handlers (entry points)
- `bot.command(['start', 'help'])` (L600) -> `deleteCommand()`, `helpText()`
- `bot.command('chatid')` (L606) -> `deleteCommand()`, `escapeHtml()`, `isOwner()`, `topicOf()`
- `bot.command(['clip', 'c'])` (L757) -> `mayScreenshot()`, `parseTime()`, `sendClip()`, `videoIn()`
- `bot.command(['frame', 'f'])` (L819) -> `parseTime()`, `sendFrames()`, `videoIn()`
- `bot.command('file')` (L885) -> `isReddit()`, `mayUseReddit`, `postOfMessage()`, `sendFiles()`, `videoIn()`
- `bot.command('sticker')` (L969) -> `imageIn()`, `sendSticker()`, `stickerEmoji()`
- `bot.callbackQuery(STICKER_PACK_DATA)` (L1006) -> `packName()`
- `bot.command('pdf')` (L1079) -> `makePdf()`, `ownerOfPost()`, `pdfFileName()`, `pdfPageOf()`, `postOfMessage()`, `schedulePdfAlbum()`
- `bot.on('message:document')` (L1186) -> `takeForPdf()`
- `bot.command('stats')` (L1320) -> `bandwidthLines()`, `cacheSize()`, `deleteCommand()`, `escapeHtml()`, `formatMb()`, `isOwner()`, `resourceLines()`
- `bot.on(['message:photo', 'message:video'])` (L1358) -> `resendMedia()`, `takeForPdf()`, `topicOf()`
- `bot.on('message:text')` (L1427) -> `isReddit()`, `mayUseReddit`, `needsLogin()`, `parseFacebookLink()`, `parseInstagramLink()`, `parseRedditLink()`, `parseSnapchatLink()`, `parseThreadsLink()`, `parseXLink()`, `replyUnsupportedSite()`, `sendMedia()`
- `bot.on('inline_query')` (L1644) -> `getFileIds()`, `inlineNote()`, `isReddit()`, `mayUseReddit`, `needsLogin()`, `parseLink()`, `prepareInline()`, `siteName()`
- `bot.on('chosen_inline_result')` (L1695) -> `requestFor()`, `sendInline()`
- `bot.callbackQuery(SCREENSHOT_DATA)` (L1756) -> `isReddit()`, `mayScreenshot()`, `mayUseReddit`, `requestFor()`, `sendScreenshots()`
- `bot.callbackQuery(DISMISS_DATA)` (L1771) -> `mayScreenshot()`
- `bot.callbackQuery(new)` (L1779) -> `applyButtonCleanup()`, `mayScreenshot()`, `planButtonCleanup()`
- `bot.callbackQuery(CLOSE_DATA)` (L1787) -> (inline)
- `bot.on('callback_query:data')` (L1793) -> (inline)
- `bot.catch()` (L1839) -> (inline)

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
Nodes (38): bot.js, bot, mayUseReddit, mayScreenshot(), node:fs, node:fs/promises, node:path, OWNER_USERS (+30 more)

### Community 1 - "Download Cache"
Cohesion: 0.5
Nodes (4): getMedia(), loadOrDownload(), pruneCache(), inFlight

### Community 2 - "Captions, Loader & Album Sending"
Cohesion: 0.08
Nodes (22): buildCaption(), startLoader(), sendAlbums(), isReddit(), siteName(), siteOf(), escapeHtml(), screenshotKeyboard() (+14 more)

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
Nodes (16): bandwidthLines(), bot.command('stats'), countDownload(), resourceLines(), formatMb(), renderBandwidth(), STATS_TIMEZONE, bar() (+8 more)

### Community 11 - "Re-sending Photos & Videos"
Cohesion: 0.5
Nodes (4): bot.on(['message:photo', 'message:video']), resendMedia(), COLLECT_MS, pendingMedia

### Community 12 - "Links to Downloads (Request Flow)"
Cohesion: 0.22
Nodes (9): sendMedia(), deliver(), bot.on('message:text'), alertFailure(), archiveCopy(), replyUnsupportedSite(), ALERT_EVERY_MS, EXPECTED_FAILURES (+1 more)

### Community 13 - "bot.js: inline mode"
Cohesion: 0.22
Nodes (9): bot.on('inline_query'), prepareInline(), parseLink(), sendInline(), SHARE_RESOLVERS, bot.on('chosen_inline_result'), INLINE_RESULT, inlineNote() (+1 more)

### Community 14 - "Screenshot Buttons"
Cohesion: 0.05
Nodes (7): bot.callbackQuery(SCREENSHOT_DATA), sendScreenshots(), bot.callbackQuery(new), bot.callbackQuery(DISMISS_DATA), bot.callbackQuery(CLOSE_DATA), bot.catch(), bot.on('callback_query:data')

### Community 15 - "Startup & Webhook Server"
Cohesion: 0.33
Nodes (3): logStarted(), startWebhook(), WEBHOOK_URL

### Community 16 - "Facebook"
Cohesion: 0.12
Nodes (37): facebook.js, parseFacebookLink(), downloadImage(), readFacebookPhoto(), readFacebookPost(), resolveFacebookShareLink(), digits(), fetchPage() (+29 more)

### Community 17 - "fileIds.js"
Cohesion: 0.53
Nodes (6): setFileIds(), fileIds.js, fileIdOf(), getFileIds(), cache, MAX_KEYS

### Community 18 - "ffmpeg (Frames, Clips, Stickers)"
Cohesion: 0.14
Nodes (33): frames.js, run, dropRepeats(), FFMPEG, makeSticker(), cutClip(), ensureH264(), extractFrames() (+25 more)

### Community 19 - "Instagram, Keys & yt-dlp"
Cohesion: 0.15
Nodes (28): instagram.js, requestFor(), downloadMedia(), parseInstagramLink(), runYtdlp(), needsLogin(), downloadPostItems(), resolveShareLink() (+20 more)

### Community 20 - "PDF Writer"
Cohesion: 0.6
Nodes (6): buildPdf(), pdf.js, embeddable(), jpegInfo(), A4, MARGIN

### Community 21 - "Reddit"
Cohesion: 0.17
Nodes (30): reddit.js, parseRedditLink(), downloadRedditFile(), getJson(), resolveRedditShareLink(), accessToken(), postItems(), readRedditPost() (+22 more)

### Community 22 - "Snapchat"
Cohesion: 0.15
Nodes (30): snapchat.js, parseSnapchatLink(), readSnapchat(), resolveSnapchatShareLink(), spotlightFromProfile(), downloadFile(), downloadSnapchat(), fetchPage() (+22 more)

### Community 23 - "Threads"
Cohesion: 0.19
Nodes (25): threads.js, queryPost(), downloadThreadsPost(), parseThreadsLink(), downloadFile(), resolveThreadsShareLink(), threadsError(), BROWSER_UA (+17 more)

### Community 24 - "X (Twitter)"
Cohesion: 0.2
Nodes (22): x.js, parseXLink(), downloadXPost(), downloadFile(), fetchPost(), resolveXShareLink(), pickUrl(), readPost() (+14 more)

### Community 25 - "yt-dlp Instagram Plugin"
Cohesion: 0.33
Nodes (9): instagram_photos.py, _add_photo_format(), _embedded_reels(), _InstagramStoryPhotosIE, _find_keys(), _InstagramPhotosIE, json, re (+1 more)
