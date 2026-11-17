import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

async function probeDuration(videoPath) {
  const { stdout } = await run(FFPROBE, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'csv=p=0',
    videoPath,
  ]);
  return Number.parseFloat(stdout);
}

/**
 * Saves `count` evenly spaced frames from the video as full-resolution JPEGs in `outDir`.
 * Each frame is taken from the middle of its slice, so you never get the black first/last frame.
 * Pass `duration` (seconds) if you already know it; otherwise ffprobe reads it.
 */
export async function extractFrames(videoPath, outDir, count, duration) {
  const total = duration > 0 ? duration : await probeDuration(videoPath);
  if (!(total > 0)) throw new Error(`Could not read the duration of ${videoPath}`);

  return Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const time = ((i + 0.5) * total) / count;
      const file = path.join(outDir, `frame_${String(i + 1).padStart(2, '0')}.jpg`);
      await run(FFMPEG, [
        '-y',
        '-loglevel', 'error',
        '-ss', time.toFixed(3),
        '-i', videoPath,
        '-frames:v', '1',
        '-q:v', '2',
        file,
      ]);
      return { file, time };
    }),
  );
}
