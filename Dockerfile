# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS web-build
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run -s build

FROM denoland/deno:latest AS api-build
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
  g++ \
  git \
  pkg-config \
  libsqlite3-dev \
  ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /build/api
COPY api/ ./
# celer-mem sources are not vendored; build.sh fetches them from the canonical
# repo at this pinned ref. Bump deliberately.
ENV CELER_MEM_GIT_REF=v3.1.0
RUN ./native/build.sh
ENV DENO_DIR=/deno-dir
RUN deno cache src/main.ts

# Upstream headless chromium for the RetV functional-test agent. The Debian
# distro chromium build SIGTRAPs in containers on some kernels (e.g. WSL2);
# chromedp/headless-shell is the battle-tested container build.
FROM chromedp/headless-shell:stable AS chrome

FROM denoland/deno:latest AS runtime
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
  libsqlite3-0 \
  ca-certificates \
  fonts-liberation \
  libnss3 \
  libexpat1 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=chrome /headless-shell /headless-shell
WORKDIR /app/api
COPY --from=api-build /build/api /app/api
COPY --from=web-build /build/web/dist/capillary-web/browser /app/web-dist
# Ship the dependency cache so startup needs no network and no cache writes
# (the container may run as an arbitrary non-root uid via compose).
ENV DENO_DIR=/deno-dir
COPY --from=api-build /deno-dir /deno-dir
RUN mkdir -p /var/lib/capillary /app/api/.data/review_captures \
  && chown -R deno:deno /var/lib/capillary /app \
  && chmod -R u+rwX,g+rwX /var/lib/capillary /app/api/.data \
  && chmod -R a+rX /deno-dir

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
USER deno

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["deno", "eval", "const r = await fetch(`http://127.0.0.1:${Deno.env.get('PORT') || 8080}/healthz`); if (!r.ok) Deno.exit(1);"]

CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-run", "--allow-read", "--allow-write", "--allow-ffi", "src/main.ts"]
