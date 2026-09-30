# syntax=docker/dockerfile:1

FROM node:24-bookworm AS ui-build
WORKDIR /build/ui
COPY ui/package*.json ./
RUN npm ci
COPY ui/ ./
RUN npm run build

FROM node:24-bookworm AS runtime
ARG BURROW_UID=4226
ARG BURROW_GID=4226
ENV NODE_ENV=production \
    HOME=/home/burrow \
    BURROW_RUNTIME_ROOT=/data \
    BURROW_POSTGRES_LIFECYCLE=managed \
    PATH=/usr/lib/postgresql/17/bin:$PATH \
    BURROW_UI_HOST=0.0.0.0 \
    BURROW_UI_PORT=42817

# PostgreSQL is installed in the same image for the default managed lifecycle.
# Keep the binary major explicit: the lifecycle refuses to start incompatible
# data directories. Explicit external/disabled lifecycle overrides remain supported.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
    && install -d -m 0755 /etc/apt/keyrings \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /etc/apt/keyrings/postgresql.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/postgresql.gpg] http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-17 postgresql-client-17 postgresql-17-pgvector \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid "$BURROW_GID" burrow \
    && useradd --uid "$BURROW_UID" --gid "$BURROW_GID" --create-home --home-dir /home/burrow --shell /bin/bash burrow
WORKDIR /opt/burrow

COPY backend/package*.json ./
RUN npm ci --omit=dev
COPY --chown=burrow:burrow backend/ ./
COPY --chown=burrow:burrow --from=ui-build /build/ui/dist ./public/ui
COPY --chown=burrow:burrow docker-entrypoint.sh /usr/local/bin/burrow-docker-entrypoint

RUN chmod 0555 /usr/local/bin/burrow-docker-entrypoint \
    && mkdir -p /data \
    && chown -R burrow:burrow /opt/burrow /home/burrow /data

USER burrow
EXPOSE 42817 7443
VOLUME ["/data"]
# The health API is authenticated. A 401 proves HTTP liveness without bypassing auth.
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
  CMD node -e "fetch(\"http://127.0.0.1:42817/api/health\").then(r => process.exit(r.ok || r.status === 401 ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["/usr/local/bin/burrow-docker-entrypoint"]
CMD ["node", "bin/burrow.mjs", "serve", "--root", "/opt/burrow"]
