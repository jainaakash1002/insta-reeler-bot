/*
 * The file_id cache: download key → the Telegram file_ids of what the bot already uploaded for it.
 * A file_id never expires and resending one costs no download or upload, so inline mode can answer
 * a link it has seen at once, and a repeated link needn't be downloaded again.
 *
 * For now it lives in memory (lost when the free Render instance sleeps or restarts). Every caller
 * goes through getFileIds/setFileIds, which are already async, so Redis (e.g. Upstash's free tier)
 * can replace the Map later without touching bot.js: GET/SET `fid:<key>` with the JSON below.
 *
 * Value: { items: [{ n, kind: 'photo'|'video', fileId, width, height, duration }], count, caption }
 * `count` is how many items the post has (items may hold only some of them).
 */

const MAX_KEYS = 5000;
const cache = new Map();

export async function getFileIds(key) {
  const value = cache.get(key);
  if (!value) return null;
  cache.delete(key); // move to the end: least recently used goes first
  cache.set(key, value);
  return value;
}

/** Merges `items` into what is cached for `key` (by item number). */
export async function setFileIds(key, { items, count, caption }) {
  const old = cache.get(key);
  const byN = new Map((old?.items ?? []).map((item) => [item.n, item]));
  for (const item of items) byN.set(item.n, item);
  cache.delete(key);
  cache.set(key, {
    items: [...byN.values()].sort((a, b) => a.n - b.n),
    count: count ?? old?.count ?? byN.size,
    caption: caption ?? old?.caption ?? '',
  });
  while (cache.size > MAX_KEYS) cache.delete(cache.keys().next().value);
}

/** The Telegram file_id of a sent photo or video message, with its size details. */
export function fileIdOf(message, n) {
  if (message?.video) {
    const { file_id: fileId, width, height, duration } = message.video;
    return { n, kind: 'video', fileId, width, height, duration };
  }
  const photo = message?.photo?.at(-1);
  return photo ? { n, kind: 'photo', fileId: photo.file_id, width: photo.width, height: photo.height } : null;
}
