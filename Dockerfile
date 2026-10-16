# syntax=docker/dockerfile:1.7
#
# Capillary image: Node 24 + Express API, celer-mem via koffi FFI, Angular SPA.
#   docker build -t ghcr.io/solesius/capillary-cr:latest .
#
# Drop-in for the Deno images (<= 1.2.1): same base distro (Debian 13), port,
# paths, env surface, uid/gid (1993), tini as PID 1, and the same native
# library built from the same celer-mem ref — existing named volumes open
# unchanged. See docs/node-migration.md.
FROM node:22-bookworm-slim AS web-build
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run -s build

FROM node:24-trixie-slim AS api-build
RUN apt-get update && apt-get install -y --no-install-recommends \
  g++ \
  git \
  pkg-config \
  libsqlite3-dev \
  librocksdb-dev \
  ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /build/api
COPY api/package.json api/package-lock.json ./
# Install scripts run only for the packages allow-listed in package.json
# (koffi, sharp, protobufjs) — they fetch prebuilt native binaries.
RUN npm ci
COPY api/ ./
# celer-mem sources are not vendored; build.sh fetches them from the canonical
# repo at this pinned ref. Bump deliberately.
ENV CELER_MEM_GIT_REF=v3.1.0
RUN ./native/build.sh \
  && rm -rf native/.deps
# Type-check is a build gate; the runtime executes the TypeScript sources
# directly (Node's type stripping), so there is no emit step.
RUN npm run -s check && npm prune --omit=dev

# Upstream headless chromium for the RetV functional-test agent. The Debian
# distro chromium build SIGTRAPs in containers on some kernels (e.g. WSL2);
# chromedp/headless-shell is the battle-tested container build.
FROM chromedp/headless-shell:stable AS chrome

FROM node:24-trixie-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
  libsqlite3-0 \
  librocksdb-dev \
  ca-certificates \
  fonts-liberation \
  libnss3 \
  libexpat1 \
  tini \
  && rm -rf /var/lib/apt/lists/* \
  && ln -s /usr/bin/tini /tini \
  # Same uid/gid as the Deno images' user, so volumes they created stay
  # writable without a chown.
  && groupadd --gid 1993 capillary \
  && useradd --uid 1993 --gid 1993 --no-create-home --home-dir /tmp \
    --shell /usr/sbin/nologin capillary
COPY --from=chrome /headless-shell /headless-shell
WORKDIR /app/api
COPY --from=api-build --chown=1993:1993 /build/api /app/api
COPY --from=web-build --chown=1993:1993 /build/web/dist/capillary-web/browser /app/web-dist
RUN mkdir -p /var/lib/capillary /app/api/.data/review_captures \
  && chown 1993:1993 /var/lib/capillary /app /app/api/.data /app/api/.data/review_captures \
  && chmod u+rwX,g+rwX /var/lib/capillary /app/api/.data /app/api/.data/review_captures \
  && chmod 0755 /app/api/docker-entrypoint.sh

ENV NODE_ENV=production
ENV PORT=8080
ENV CORS_ORIGIN=http://localhost:8080
ENV CAPILLARY_SERVE_WEB=1
ENV CAPILLARY_WEB_DIST=/app/web-dist
ENV CAPILLARY_STORAGE_DIR=/var/lib/capillary
ENV CAPILLARY_REQUIRE_GITHUB_LOGIN=1
# RetV browser agent: bundled headless chromium; flags required to launch as a
# non-root container user (HOME may be unset/unwritable under a compose uid).
ENV CHROME_PATH=/headless-shell/headless-shell
ENV CDP_LAUNCH_FLAGS="--no-sandbox --disable-gpu --disable-dev-shm-usage --disable-crashpad"
ENV HOME=/tmp

EXPOSE 8080
USER capillary

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 8080}/healthz`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--", "/app/api/docker-entrypoint.sh"]
CMD ["node", "src/main.ts"]
