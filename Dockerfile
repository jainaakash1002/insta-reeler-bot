# The bot in a container, with yt-dlp, ffmpeg and ffprobe (for Render, Railway, a VPS, …).
# Configuration comes from environment variables (BOT_TOKEN, …); .env is never copied in.
FROM node:22-bookworm-slim

# ffmpeg/ffprobe from Debian; yt-dlp from PyPI, because Debian's package is too old for Instagram.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && python3 -m venv /opt/yt-dlp \
  && /opt/yt-dlp/bin/pip install --no-cache-dir --upgrade yt-dlp \
  && ln -s /opt/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY yt-dlp-plugins ./yt-dlp-plugins

ENV NODE_ENV=production
USER node
CMD ["node", "src/bot.js"]
