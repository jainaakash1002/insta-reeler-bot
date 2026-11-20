import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

/*
 * Memory. Each ffmpeg decoding a 1080p video takes tens of MB, more with many threads. On a
 * small host (Render's free plan: 512 MB) running all the screenshot ffmpegs at once got the
 * bot killed for using too much memory, with no error. So the container's memory limit is
 * read (cgroup v2, then v1, then the machine's RAM); under 1 GB, ffmpeg runs one job at a
 * time on one thread. FFMPEG_JOBS overrides the number of parallel jobs.
 */
function memoryLimit() {
  for (const file of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const bytes = Number(readFileSync(file, 'utf8').trim()); // "max" (no limit) gives NaN
      if (bytes > 0 && bytes < os.totalmem()) return bytes;
    } catch {
      // not Linux, or no cgroup limit
    }
  }
  return os.totalmem();
}
export const LOW_MEMORY = memoryLimit() < 1024 ** 3;
const JOBS = Math.max(1, Number(process.env.FFMPEG_JOBS) || (LOW_MEMORY ? 1 : 4));
const THREADS = LOW_MEMORY ? ['-threads', '1'] : [];
export const ffmpegMode = `ffmpeg: ${JOBS} job(s) at a time${LOW_MEMORY ? ', 1 thread (low memory)' : ''}`;

/** Like Promise.all(items.map(fn)), but at most JOBS calls run at once. */
async function mapLimited(items, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(JOBS, items.length) }, worker));
  return results;
}

async function probeDuration(videoPath) {
  const { stdout } = await run(FFPROBE, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'csv=p=0',
    videoPath,
  ]);
  return Number.parseFloat(stdout);
}

/** Saves the first frame at or after `time` as a JPEG. Returns false if ffmpeg found none there. */
async function grabFrame(videoPath, file, time) {
  await run(FFMPEG, [
    '-y',
    '-loglevel', 'error',
    '-threads', '1', // one frame needs no decoding threads, and each one costs memory
    '-ss', time.toFixed(3),
    '-i', videoPath,
    '-frames:v', '1',
    // Videos are usually limited-range ("tv") color; JPEG is full range, and recent
    // ffmpeg's JPEG encoder refuses limited-range frames. Convert them, and let the
    // encoder accept the odd frame the conversion misses (seen near the end of some
    // Instagram videos) instead of failing the whole screenshot set.
    '-vf', 'scale=out_range=full',
    '-strict', 'unofficial',
    '-update', '1', // one image, not an image sequence
    '-q:v', '2',
    file,
  ]);
  // ffmpeg exits 0 without writing anything when no frame starts after `time`.
  return fs.stat(file).then((stat) => stat.size > 0, () => false);
}

/**
 * Saves up to `count` evenly spaced frames from the video as full-resolution JPEGs in `outDir`.
 * Each frame is taken from the middle of its slice, so you never get the black first/last frame.
 * Pass `duration` (seconds) if you already know it; otherwise ffprobe reads it.
 * Returns the frames that could be grabbed; throws (with `source: 'ffmpeg'`) if none could.
 */
export async function extractFrames(videoPath, outDir, count, duration) {
  try {
    return await grabFrames(videoPath, outDir, count, duration);
  } catch (err) {
    throw Object.assign(err, { source: 'ffmpeg' }); // so the bot doesn't blame Instagram
  }
}

async function grabFrames(videoPath, outDir, count, duration) {
  const total = duration > 0 ? duration : await probeDuration(videoPath);
  if (!(total > 0)) throw new Error(`Could not read the duration of ${videoPath}`);
  const slice = total / count;

  const frames = await mapLimited(
    Array.from({ length: count }, (_, i) => i),
    async (i) => {
      const file = path.join(outDir, `frame_${String(i + 1).padStart(2, '0')}.jpg`);
      // The middle of the slice, or its start if there's no frame after the middle
      // (low-frame-rate videos, like slideshows Instagram makes from photo stories).
      for (const time of [(i + 0.5) * slice, i * slice]) {
        if (await grabFrame(videoPath, file, time)) return { file, time };
      }
      return null;
    },
  );

  const grabbed = frames.filter(Boolean);
  if (grabbed.length === 0) throw new Error(`ffmpeg found no frames in ${videoPath}`);
  return grabbed;
}

// Two frames count as the same picture when their 32x32 grayscale versions differ by less
// than this on average (0-255 scale). Measured on real Instagram videos: a photo story with
// music gives 0.0 between frames, a nearly still clip under 1.5, ordinary videos 4.7 and up.
const SIGNATURE_SIZE = 32;
const SAME_PICTURE_BELOW = 2;

async function signature(file) {
  const { stdout } = await run(
    FFMPEG,
    ['-loglevel', 'error', '-i', file, '-vf', `scale=${SIGNATURE_SIZE}:${SIGNATURE_SIZE},format=gray`, '-f', 'rawvideo', 'pipe:1'],
    { encoding: 'buffer' },
  );
  return stdout;
}

function difference(a, b) {
  if (a.length !== b.length || a.length === 0) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

/**
 * Drops frames that look the same as the previous frame kept, so a still picture with
 * music comes back as a single frame. If the comparison fails, returns all frames.
 */
export async function dropRepeats(frames) {
  if (frames.length < 2) return frames;
  try {
    const signatures = await mapLimited(frames, (frame) => signature(frame.file));
    const kept = [];
    let last;
    frames.forEach((frame, i) => {
      if (last && difference(signatures[i], last) < SAME_PICTURE_BELOW) return;
      kept.push(frame);
      last = signatures[i];
    });
    return kept;
  } catch (err) {
    console.warn('Could not compare screenshots; sending them all:', err?.stderr || err);
    return frames;
  }
}

const TRANSCODE_TIMEOUT_MS = 10 * 60 * 1000;

async function videoCodec(videoPath) {
  const { stdout } = await run(FFPROBE, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name',
    '-of', 'csv=p=0',
    videoPath,
  ]);
  return stdout.trim();
}

/**
 * Re-encodes a video to H.264 in place unless it already is. Facebook often serves only
 * VP9, which Telegram's iPhone app can't play inline. On failure the original is kept
 * (a warning is logged), since an odd codec is better than no video.
 */
export async function ensureH264(videoPath) {
  const temp = `${videoPath}.h264.mp4`;
  try {
    if ((await videoCodec(videoPath)) === 'h264') return;
    await run(
      FFMPEG,
      [
        '-y',
        '-loglevel', 'error',
        '-i', videoPath,
        '-map', '0:v:0',
        '-map', '0:a:0?', // the audio, if there is any
        '-c:v', 'libx264',
        ...THREADS,
        '-preset', 'veryfast',
        '-crf', '23',
        '-pix_fmt', 'yuv420p', // the most widely playable H.264
        '-c:a', 'copy',
        '-movflags', '+faststart', // lets Telegram start playing before the whole file arrives
        temp,
      ],
      { timeout: TRANSCODE_TIMEOUT_MS },
    );
    await fs.rename(temp, videoPath);
  } catch (err) {
    console.warn(`Could not convert ${videoPath} to H.264; sending it as it is:`, err?.stderr || err?.message || err);
    await fs.rm(temp, { force: true });
  }
}
