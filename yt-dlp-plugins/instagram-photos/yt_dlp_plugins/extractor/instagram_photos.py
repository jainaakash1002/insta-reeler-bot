"""yt-dlp plugin: fixes for Instagram photos and stories.

1. Photos. yt-dlp's Instagram extractors only return videos. A photo post fails
   with "There is no video in this post", carousels lose their photos and photo
   stories are dropped. This plugin offers each photo's full-size image as a
   single "photo" format, so yt-dlp downloads photos and videos the same way.

2. Stories. yt-dlp's story extractor loads the story page, then asks the
   /api/v1/feed/reels_media/ endpoint for the items. Instagram now answers that
   request with HTTP 500, so stories fail with "You need to log in" even with a
   valid login. The logged-in story page already embeds the same reels_media
   data, so when the API comes back empty this plugin answers it from the page.
   If Instagram fixes the endpoint, the API result is used again.

The bot loads it with `--plugin-dirs <repo>/yt-dlp-plugins`.
"""

import json
import re

from yt_dlp.extractor.instagram import InstagramIE, InstagramStoryIE
from yt_dlp.utils import determine_ext, traverse_obj

_SJS_RE = re.compile(r'<script\b[^>]+\bdata-sjs>(\{.+?\})</script>')
_REELS_MEDIA_KEY = 'xdt_api__v1__feed__reels_media'


def _add_photo_format(info):
    thumbnails = info.get('thumbnails') or []
    if info.get('formats') or not thumbnails:
        return info
    # Instagram lists image candidates largest first and yt-dlp reverses them,
    # so the full-size image is last. Sort by area in case that ever changes;
    # the sort is stable, so the last one still wins when sizes are missing.
    best = sorted(thumbnails, key=lambda t: (t.get('width') or 0) * (t.get('height') or 0))[-1]
    info['formats'] = [{
        'format_id': 'photo',
        'url': best['url'],
        'ext': determine_ext(best['url'], 'jpg'),
        'width': best.get('width'),
        'height': best.get('height'),
        'vcodec': 'none',
        'acodec': 'none',
    }]
    return info


# Where a story page keeps its reels (a user's stories or a highlight, with their items):
# user story pages under `xdt_api__v1__feed__reels_media.reels_media[]`,
# highlight pages under `xdt_api__v1__feed__reels_media__connection.edges[].node`.
_REEL_PATHS = {
    _REELS_MEDIA_KEY: ('reels_media', ...),
    f'{_REELS_MEDIA_KEY}__connection': ('edges', ..., 'node'),
}


def _find_keys(obj, keys):
    """Yields (key, value) for every key in `keys` anywhere in a nested JSON structure."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in keys:
                yield k, v
            yield from _find_keys(v, keys)
    elif isinstance(obj, list):
        for v in obj:
            yield from _find_keys(v, keys)


def _embedded_reels(webpage):
    """The reels data embedded in a logged-in story page, keyed by reel id like the API's 'reels'."""
    reels = {}
    for block in _SJS_RE.findall(webpage or ''):
        if _REELS_MEDIA_KEY not in block:
            continue
        try:
            data = json.loads(block)
        except json.JSONDecodeError:
            continue
        for key, value in _find_keys(data, _REEL_PATHS):
            for reel in traverse_obj(value, (*_REEL_PATHS[key], {dict})):
                if not (reel.get('id') and reel.get('items')):
                    continue
                # Highlight items carry a user object without a username; the reel's has it.
                for item in reel['items']:
                    item['user'] = {**(reel.get('user') or {}), **(item.get('user') or {})}
                reels.setdefault(str(reel['id']), reel)
    return reels


class _InstagramPhotosIE(InstagramIE, plugin_name='photos'):
    def _extract_product_media(self, product_media):
        return _add_photo_format(super()._extract_product_media(product_media))


class _InstagramStoryPhotosIE(InstagramStoryIE, plugin_name='photos'):
    def _extract_product_media(self, product_media):
        return _add_photo_format(super()._extract_product_media(product_media))

    def _download_webpage(self, *args, **kwargs):
        webpage = super()._download_webpage(*args, **kwargs)
        if isinstance(webpage, str):
            self._story_webpage = webpage  # the story page; read below if the API fails
        return webpage

    def _download_json(self, url_or_request, *args, **kwargs):
        result = super()._download_json(url_or_request, *args, **kwargs)
        url = getattr(url_or_request, 'url', url_or_request)
        if '/feed/reels_media/' in str(url) and not traverse_obj(result, 'reels'):
            reels = _embedded_reels(getattr(self, '_story_webpage', None))
            if reels:
                self.write_debug('reels_media API returned nothing; using the data embedded in the story page')
                return {'reels': reels}
        return result
