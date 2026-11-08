# An isolated Console: its own database, its own servers, its own files, nothing shared with the host.
# Built and run for you by install.sh (choose "Docker instance"), or by hand:
#   docker build -f deploy/Dockerfile -t console:local .
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-package-lock --no-audit --no-fund --loglevel=error
COPY web ./web
COPY server ./server
COPY deploy ./deploy
RUN npm run build --silent && npm prune --omit=dev --no-package-lock --loglevel=error

# Java 21 is included so Minecraft servers run inside the container.
FROM eclipse-temurin:21-jre-jammy
RUN apt-get update \
 && apt-get install -y --no-install-recommends git tmux tar curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/node /usr/local/bin/node
RUN useradd -m -u 10001 -s /bin/bash console && mkdir -p /data && chown console:console /data
WORKDIR /app
COPY --from=build /app /app
USER console
ENV HOST=0.0.0.0 PORT=3000 HOME=/home/console \
    CONSOLE_DB=/data/console.db CONSOLE_SERVERS=/data/servers.json CONSOLE_DATA=/data \
    CONSOLE_APPS_DIR=/data/servers CONSOLE_RUN_USER=console
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/me').then(()=>process.exit(0),()=>process.exit(1))"
CMD ["node", "server/src/index.js"]
