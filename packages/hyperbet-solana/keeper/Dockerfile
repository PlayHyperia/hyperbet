FROM oven/bun:1.3.6

WORKDIR /app

COPY workspace.package.json ./package.json
COPY workspace.bun.lock ./bun.lock
COPY workspace-packages/packages ./packages
COPY package.json ./packages/hyperbet-solana/keeper/package.json
COPY tsconfig.json ./packages/hyperbet-solana/keeper/tsconfig.json
COPY workspace-runtime-src ./packages/hyperbet-solana/keeper/src
COPY start.sh ./packages/hyperbet-solana/keeper/start.sh

RUN chmod +x ./packages/hyperbet-solana/keeper/start.sh
# The SOL keeper uses the pure-JavaScript WebSocket path. Its transitive
# bufferutil/utf-8-validate packages are optional accelerators whose node-gyp
# hooks fail in the minimal release image and are not runtime requirements.
# Keep the lock exact while excluding all dependency lifecycle execution.
RUN bun install --frozen-lockfile --production --ignore-scripts

RUN chmod -R a=rX /app/packages && \
    mkdir -p /app/data/status && \
    chown -R bun:bun /app/data

WORKDIR /app/packages/hyperbet-solana/keeper

ENV NODE_ENV=production
ENV PORT=8080
ENV KEEPER_DB_PATH=/app/data/keeper.sqlite
ENV KEEPER_BOT_HEALTH_FILE=/app/data/status/keeper-bot-health.json
ENV KEEPER_STREAM_STATE_FILE=/app/data/status/stream-state.json
ENV HYPERBET_OPERATOR_ALERT_STATE_FILE=/app/data/status/operator-alert-state.json

USER bun

EXPOSE 8080

CMD ["bash", "start.sh"]
