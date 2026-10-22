FROM oven/bun:1.3.8@sha256:371d30538b69303ced927bb5915697ac7e2fa8cb409ee332c66009de64de5aa3
WORKDIR /app/keeper
COPY .host-runtime/keeper/package.json .host-runtime/keeper/bun.lock ./
RUN bun install --frozen-lockfile --production
COPY .host-runtime/keeper/src ./src
COPY .host-runtime/keeper/cloudflare ./cloudflare
COPY .host-runtime/deployments /app/deployments
COPY .host-runtime/host-provenance.json /app/host-provenance.json
ENV NODE_ENV=production PORT=8080
USER bun
EXPOSE 8080
CMD ["bun", "cloudflare/runtime-supervisor.mjs"]
