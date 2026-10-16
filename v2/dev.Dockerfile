# Dev toolchain for the v2 API: Node 24 + the native build deps for celer-mem.
# Used to install, type-check, build the FFI shim and run tests with the repo
# bind-mounted. Not shipped.
FROM node:24-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
  g++ git pkg-config libsqlite3-dev librocksdb-dev ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /work/api
