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

# Backend policy: RocksDB (LSM, high write throughput) is the default. It is what
# every container build uses — the Docker image is Linux regardless of host, so a
# Mac-ARM or Windows Docker host still ships RocksDB and is never on the slow path.
#
# The only case that can fall back to SQLite is a *bare-metal* build on macOS,
# where RocksDB has no default system location. There we still prefer RocksDB if
# Homebrew has it (`brew install rocksdb`) so native Mac dev isn't stuck slow, and
# only drop to SQLite when it is genuinely absent. Override with
# CELER_BACKEND=sqlite|rocksdb.
UNAME_S="$(uname -s)"
CELER_BACKEND="${CELER_BACKEND:-}"
BREW_PREFIX=""
if [[ -z "${CELER_BACKEND}" ]]; then
  if [[ "${UNAME_S}" == "Darwin" ]]; then
    if command -v brew >/dev/null 2>&1 && brew --prefix rocksdb >/dev/null 2>&1; then
      CELER_BACKEND="rocksdb"
    else
      CELER_BACKEND="sqlite"
      echo "macOS without Homebrew rocksdb — falling back to SQLite backend." >&2
      echo "  For the fast path: brew install rocksdb" >&2
    fi
  else
    CELER_BACKEND="rocksdb"
  fi
fi
# Homebrew installs headers/libs outside the default search path; add them so
# -lrocksdb / -lsqlite3 resolve on macOS.
if [[ "${UNAME_S}" == "Darwin" ]] && command -v brew >/dev/null 2>&1; then
  BREW_PREFIX="$(brew --prefix)"
fi

SRCS=(
  "${HERE}/celer_ffi.cpp"
  "${CELER}/src/api/global.cpp"
  "${CELER}/src/backend/sqlite.cpp"
  "${CELER}/src/core/dispatch.cpp"
  "${CELER}/src/core/tree_builder.cpp"
)
DEFINES=(-DCELER_FORCE_NO_QPDF=1)
LIBS=(-lsqlite3)

if [[ "${CELER_BACKEND}" == "rocksdb" ]]; then
  echo "Backend: rocksdb"
  SRCS+=("${CELER}/src/backend/rocksdb.cpp")
  DEFINES+=(-DCELER_HAS_ROCKSDB=1)
  LIBS+=(-lrocksdb)
else
  echo "Backend: sqlite"
  DEFINES+=(-DCELER_FORCE_NO_ROCKSDB=1)
fi

INCLUDES=(-I "${CELER}/include")
LDPATHS=()
if [[ -n "${BREW_PREFIX}" ]]; then
  INCLUDES+=(-I "${BREW_PREFIX}/include")
  LDPATHS+=(-L "${BREW_PREFIX}/lib")
fi

echo "Building ${OUT} ..."
"${CXX}" -std=c++23 -O2 -fPIC -shared \
  "${DEFINES[@]}" \
  "${INCLUDES[@]}" \
  "${SRCS[@]}" \
  "${LDPATHS[@]}" \
  "${LIBS[@]}" \
  -o "${OUT}"

echo "✓ Built ${OUT} (backend=${CELER_BACKEND})"
