"""yt-dlp plugin: download Instagram photos, not just videos.

yt-dlp's Instagram extractors only return videos. A photo post fails with
"There is no video in this post", carousels lose their photos and photo
stories are dropped. This plugin offers each photo's full-size image as a
single "photo" format, so yt-dlp downloads photos and videos the same way.

The bot loads it with `--plugin-dirs <repo>/yt-dlp-plugins`.
"""

from yt_dlp.extractor.instagram import InstagramIE, InstagramStoryIE
from yt_dlp.utils import determine_ext


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


class _InstagramPhotosIE(InstagramIE, plugin_name='photos'):
    def _extract_product_media(self, product_media):
        return _add_photo_format(super()._extract_product_media(product_media))


class _InstagramStoryPhotosIE(InstagramStoryIE, plugin_name='photos'):
    def _extract_product_media(self, product_media):
        return _add_photo_format(super()._extract_product_media(product_media))
