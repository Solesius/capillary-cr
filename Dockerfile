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
RUN ./native/build.sh
RUN deno cache src/main.ts

FROM denoland/deno:latest AS runtime
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
  libsqlite3-0 \
  ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app/api
COPY --from=api-build /build/api /app/api
COPY --from=web-build /build/web/dist/capillary-web/browser /app/web-dist
RUN mkdir -p /var/lib/capillary /app/api/.data/review_captures \
  && chown -R deno:deno /var/lib/capillary /app \
  && chmod -R u+rwX,g+rwX /var/lib/capillary /app/api/.data

ENV PORT=8080
ENV CORS_ORIGIN=http://localhost:8080
ENV CAPILLARY_SERVE_WEB=1
ENV CAPILLARY_WEB_DIST=/app/web-dist
ENV CAPILLARY_STORAGE_DIR=/var/lib/capillary
ENV CAPILLARY_REQUIRE_GITHUB_LOGIN=1

EXPOSE 8080
USER deno

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["deno", "eval", "const r = await fetch(`http://127.0.0.1:${Deno.env.get('PORT') || 8080}/healthz`); if (!r.ok) Deno.exit(1);"]

CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-run", "--allow-read", "--allow-write", "--allow-ffi", "src/main.ts"]
