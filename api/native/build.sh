#!/usr/bin/env bash
# Build the celer-mem FFI shared library for Deno FFI.
#
# Compiles the celer-mem SQLite backend plus the C ABI shim (celer_ffi.cpp)
# into libceler_ffi.so. RocksDB / QPDF / S3 backends are intentionally excluded
# so the only system dependency is sqlite3 (already present on most systems).
#
# Source resolution (first match wins):
#   1) CELER_MEM_DIR (absolute or relative path)
#   2) vendored native/celer-mem
#   3) auto-fetched clone under native/.deps/celer-mem
#
# Optional env vars:
#   CELER_MEM_GIT_URL    default: https://github.com/Solesius/celer-mem.git
#   CELER_MEM_GIT_REF    default: main
#   CELER_MEM_CACHE_DIR  default: native/.deps
#   CELER_MEM_DISABLE_VENDORED=1 to skip native/celer-mem
#
# Usage: ./native/build.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDORED_CELER="${HERE}/celer-mem"
CACHE_ROOT="${CELER_MEM_CACHE_DIR:-${HERE}/.deps}"
FETCHED_CELER="${CACHE_ROOT}/celer-mem"
CELER_GIT_URL="${CELER_MEM_GIT_URL:-https://github.com/Solesius/celer-mem.git}"
CELER_GIT_REF="${CELER_MEM_GIT_REF:-main}"

have_celer_sources() {
  local dir="$1"
  [[ -d "${dir}/include/celer" && -f "${dir}/src/backend/sqlite.cpp" ]]
}

bootstrap_celer_sources() {
  if ! command -v git >/dev/null 2>&1; then
    echo "celer-mem sources are missing and git is not installed." >&2
    echo "Set CELER_MEM_DIR to an existing celer-mem checkout." >&2
    return 1
  fi

  mkdir -p "${CACHE_ROOT}"

  if [[ -d "${FETCHED_CELER}/.git" ]]; then
    echo "Updating cached celer-mem checkout in ${FETCHED_CELER} ..."
  else
    echo "Fetching celer-mem into ${FETCHED_CELER} ..."
    git -c advice.detachedHead=false clone --filter=blob:none --no-checkout \
      "${CELER_GIT_URL}" "${FETCHED_CELER}" >/dev/null
  fi

  git -C "${FETCHED_CELER}" fetch --depth 1 origin "${CELER_GIT_REF}" >/dev/null
  git -C "${FETCHED_CELER}" checkout -q FETCH_HEAD
}

CELER="${CELER_MEM_DIR:-}"
DISABLE_VENDORED="${CELER_MEM_DISABLE_VENDORED:-0}"
if [[ -n "${CELER}" ]]; then
  echo "Using CELER_MEM_DIR=${CELER}"
elif [[ "${DISABLE_VENDORED}" != "1" ]] && have_celer_sources "${VENDORED_CELER}"; then
  CELER="${VENDORED_CELER}"
  echo "Using vendored celer-mem at ${CELER}"
else
  bootstrap_celer_sources
  CELER="${FETCHED_CELER}"
fi

if ! have_celer_sources "${CELER}"; then
  echo "celer-mem sources not found at ${CELER}." >&2
  echo "Set CELER_MEM_DIR, vendor to native/celer-mem, or allow auto-fetch." >&2
  exit 1
fi

CXX="${CXX:-g++}"
OUT="${HERE}/libceler_ffi.so"

# Only the sqlite + core dispatch sources are needed; rocksdb/qpdf/s3 are off.
SRCS=(
  "${HERE}/celer_ffi.cpp"
  "${CELER}/src/api/global.cpp"
  "${CELER}/src/backend/sqlite.cpp"
  "${CELER}/src/core/dispatch.cpp"
  "${CELER}/src/core/tree_builder.cpp"
)

echo "Building ${OUT} ..."
"${CXX}" -std=c++23 -O2 -fPIC -shared \
  -DCELER_FORCE_NO_ROCKSDB=1 \
  -DCELER_FORCE_NO_QPDF=1 \
  -I "${CELER}/include" \
  "${SRCS[@]}" \
  -lsqlite3 \
  -o "${OUT}"

echo "✓ Built ${OUT}"
