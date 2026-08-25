# syntax=docker/dockerfile:1

FROM node:22-bookworm AS ui-build
WORKDIR /build/ui
COPY ui/package*.json ./
RUN npm ci
COPY ui/ ./
RUN npm run build

FROM node:22-bookworm AS runtime
ENV NODE_ENV=production \
    BURROW_RUNTIME_ROOT=/data \
    BURROW_UI_HOST=0.0.0.0 \
    BURROW_UI_PORT=42817
WORKDIR /opt/burrow

COPY backend/package*.json ./
RUN npm ci --omit=dev \
    && chown -R node:node /opt/burrow
# Burrow's Anthropic OAuth flow requires a known-compatible Claude Code CLI.
RUN npm install --global @anthropic-ai/claude-code@2.1.232
COPY --chown=node:node backend/ ./
COPY --chown=node:node --from=ui-build /build/ui/dist ./public/ui
COPY --chown=node:node docker-entrypoint.sh /usr/local/bin/burrow-docker-entrypoint

RUN chmod 0555 /usr/local/bin/burrow-docker-entrypoint \
    && mkdir -p /data \
    && chown node:node /data

USER node
EXPOSE 42817
VOLUME ["/data"]
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
  CMD node -e "fetch(\"http://127.0.0.1:42817/api/health\").then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["/usr/local/bin/burrow-docker-entrypoint"]
CMD ["node", "bin/burrow.mjs", "serve", "--root", "/opt/burrow"]
