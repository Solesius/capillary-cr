// celer_ffi.cpp — C ABI shim exposing celer-mem's embedded store to Deno FFI.
//
// Design
// ------
// celer-mem is a header-/source C++23 library whose public surface uses
// std::expected, templates, and string_views that cannot cross a C ABI. This
// shim wraps the SQLite backend behind a flat, binary-safe C interface that
// Deno.dlopen can bind. Every call returns a single heap-allocated response
// buffer with the layout below; the caller reads it and frees it with
// `celer_free`. This keeps the boundary stateless and thread-safe so the Deno
// side can mark every symbol `nonblocking` and run it off the event loop.
//
// Response buffer layout (little-endian):
//   [int32 status][int32 payload_len][payload bytes...]
//   status:  0 = ok            payload = op-specific (empty for writes)
//            1 = ok + found     payload = value bytes (get)
//            2 = ok + miss      payload = empty (get)
//           -1 = error          payload = UTF-8 error message
//
// Scan / get_many payload (status 0) is a packed pair list:
//   [int32 count] then `count` * ( [int32 klen][key][int32 vlen][value] )
//   For get_many misses, vlen is encoded as -1 (key present, value absent).

#include "celer/api/global.hpp"
#include "celer/backend/sqlite.hpp"
#if CELER_HAS_ROCKSDB
#include "celer/backend/rocksdb.hpp"
#endif

#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <string_view>
#include <vector>

using celer::BatchOp;
using celer::Error;
using celer::KVPair;
using celer::TableDescriptor;
using celer::VoidResult;

namespace {

// The celer global API wraps one process-wide Store, so serialize lifecycle
// transitions. Per-key operations dispatch through the immutable tree and are
// internally safe, but we still guard open/close.
std::mutex g_lifecycle_mu;

constexpr std::int32_t kStatusOk = 0;
constexpr std::int32_t kStatusFound = 1;
constexpr std::int32_t kStatusMiss = 2;
constexpr std::int32_t kStatusError = -1;

void write_i32(std::string& buf, std::int32_t value) {
  std::uint32_t u = static_cast<std::uint32_t>(value);
  char bytes[4] = {
      static_cast<char>(u & 0xFF),
      static_cast<char>((u >> 8) & 0xFF),
      static_cast<char>((u >> 16) & 0xFF),
      static_cast<char>((u >> 24) & 0xFF),
  };
  buf.append(bytes, 4);
}

// Allocate the [status][len][payload] response on the C heap.
char* make_response(std::int32_t status, std::string_view payload) {
  std::string buf;
  buf.reserve(8 + payload.size());
  write_i32(buf, status);
  write_i32(buf, static_cast<std::int32_t>(payload.size()));
  buf.append(payload.data(), payload.size());

  char* out = static_cast<char*>(std::malloc(buf.size()));
  if (out != nullptr) {
    std::memcpy(out, buf.data(), buf.size());
  }
  return out;
}

char* ok_response() { return make_response(kStatusOk, std::string_view{}); }

char* error_response(const Error& e) {
  std::string msg = e.code;
  msg.append(": ");
  msg.append(e.message);
  return make_response(kStatusError, msg);
}

char* error_response(std::string_view msg) { return make_response(kStatusError, msg); }

// Serialize KV pairs into the packed scan payload.
std::string encode_pairs(const std::vector<KVPair>& pairs) {
  std::string payload;
  write_i32(payload, static_cast<std::int32_t>(pairs.size()));
  for (const auto& kv : pairs) {
    write_i32(payload, static_cast<std::int32_t>(kv.key.size()));
    payload.append(kv.key);
    write_i32(payload, static_cast<std::int32_t>(kv.value.size()));
    payload.append(kv.value);
  }
  return payload;
}

}  // namespace

extern "C" {

// Open the global store. `schema` is a newline-delimited list of
// "scope\ttable" descriptors. `backend` selects the storage engine; an empty
// value or "auto" resolves to the best engine this library was built with —
// RocksDB when compiled in, otherwise SQLite. Resolving here (rather than in
// the caller) guarantees the runtime default always matches the compiled
// backend, so a SQLite-only build never fails by being asked for RocksDB.
char* celer_open(const char* backend, const char* path, const char* schema, std::int32_t schema_len) {
  std::lock_guard<std::mutex> lock(g_lifecycle_mu);

  std::string kind = backend != nullptr ? std::string(backend) : std::string{};
  if (kind.empty() || kind == "auto") {
#if CELER_HAS_ROCKSDB
    kind = "rocksdb";
#else
    kind = "sqlite";
#endif
  }
#if CELER_HAS_ROCKSDB
  const bool kind_supported = (kind == "sqlite" || kind == "rocksdb");
#else
  const bool kind_supported = (kind == "sqlite");
#endif
  if (!kind_supported) {
    return error_response(std::string("unsupported backend: ") + kind);
  }

  std::vector<TableDescriptor> tables;
  const std::string raw(schema != nullptr ? schema : "", schema_len >= 0 ? static_cast<std::size_t>(schema_len) : 0);
  std::size_t cursor = 0;
  while (cursor < raw.size()) {
    std::size_t nl = raw.find('\n', cursor);
    if (nl == std::string::npos) {
      nl = raw.size();
    }
    const std::string line = raw.substr(cursor, nl - cursor);
    cursor = nl + 1;
    const std::size_t tab = line.find('\t');
    if (tab == std::string::npos) {
      continue;
    }
    tables.push_back(TableDescriptor{line.substr(0, tab), line.substr(tab + 1)});
  }

  if (tables.empty()) {
    return error_response("schema must declare at least one scope\\ttable descriptor");
  }

  const std::string db_path = path != nullptr ? std::string(path) : std::string{};
#if CELER_HAS_ROCKSDB
  if (kind == "rocksdb") {
    celer::backends::rocksdb::Config cfg{};
    cfg.path = db_path;
    VoidResult r = celer::open(celer::backends::rocksdb::factory(cfg), tables);
    if (!r) {
      return error_response(r.error());
    }
    return ok_response();
  }
#endif
  celer::backends::sqlite::Config cfg{};
  cfg.path = db_path;
  VoidResult r = celer::open(celer::backends::sqlite::factory(cfg), tables);
  if (!r) {
    return error_response(r.error());
  }
  return ok_response();
}

char* celer_close_store() {
  std::lock_guard<std::mutex> lock(g_lifecycle_mu);
  VoidResult r = celer::close();
  if (!r) {
    return error_response(r.error());
  }
  return ok_response();
}

char* celer_put(const char* scope, const char* table, const char* key, std::int32_t klen,
                const char* value, std::int32_t vlen) {
  auto db = celer::db(scope != nullptr ? scope : "");
  if (!db) {
    return error_response(db.error());
  }
  auto tbl = db->table(table != nullptr ? table : "");
  if (!tbl) {
    return error_response(tbl.error());
  }
  const std::string_view k(key, klen >= 0 ? static_cast<std::size_t>(klen) : 0);
  const std::string_view v(value, vlen >= 0 ? static_cast<std::size_t>(vlen) : 0);
  VoidResult r = tbl->put_raw(k, v);
  if (!r) {
    return error_response(r.error());
  }
  return ok_response();
}

char* celer_get(const char* scope, const char* table, const char* key, std::int32_t klen) {
  auto db = celer::db(scope != nullptr ? scope : "");
  if (!db) {
    return error_response(db.error());
  }
  auto tbl = db->table(table != nullptr ? table : "");
  if (!tbl) {
    return error_response(tbl.error());
  }
  const std::string_view k(key, klen >= 0 ? static_cast<std::size_t>(klen) : 0);
  auto r = tbl->get_raw(k);
  if (!r) {
    return error_response(r.error());
  }
  if (!r->has_value()) {
    return make_response(kStatusMiss, std::string_view{});
  }
  return make_response(kStatusFound, r->value());
}

char* celer_del(const char* scope, const char* table, const char* key, std::int32_t klen) {
  auto db = celer::db(scope != nullptr ? scope : "");
  if (!db) {
    return error_response(db.error());
  }
  auto tbl = db->table(table != nullptr ? table : "");
  if (!tbl) {
    return error_response(tbl.error());
  }
  const std::string_view k(key, klen >= 0 ? static_cast<std::size_t>(klen) : 0);
  VoidResult r = tbl->del(k);
  if (!r) {
    return error_response(r.error());
  }
  return ok_response();
}

// Prefix scan returning packed key/value pairs (native KVPair scan).
char* celer_prefix_scan(const char* scope, const char* table, const char* prefix, std::int32_t plen) {
  auto db = celer::db(scope != nullptr ? scope : "");
  if (!db) {
    return error_response(db.error());
  }
  auto tbl = db->table(table != nullptr ? table : "");
  if (!tbl) {
    return error_response(tbl.error());
  }
  const std::string_view p(prefix, plen >= 0 ? static_cast<std::size_t>(plen) : 0);
  auto r = tbl->handle()->prefix_scan(p);
  if (!r) {
    return error_response(r.error());
  }
  return make_response(kStatusOk, encode_pairs(*r));
}

// Atomic batch of puts/deletes encoded as the packed pair list. A value length
// of -1 marks a delete; otherwise it is a put.
char* celer_batch(const char* scope, const char* table, const char* ops, std::int32_t ops_len) {
  auto db = celer::db(scope != nullptr ? scope : "");
  if (!db) {
    return error_response(db.error());
  }
  auto tbl = db->table(table != nullptr ? table : "");
  if (!tbl) {
    return error_response(tbl.error());
  }

  const auto read_i32 = [&](std::size_t at) -> std::int32_t {
    std::uint32_t u = static_cast<std::uint8_t>(ops[at]) |
                      (static_cast<std::uint32_t>(static_cast<std::uint8_t>(ops[at + 1])) << 8) |
                      (static_cast<std::uint32_t>(static_cast<std::uint8_t>(ops[at + 2])) << 16) |
                      (static_cast<std::uint32_t>(static_cast<std::uint8_t>(ops[at + 3])) << 24);
    return static_cast<std::int32_t>(u);
  };

  const std::size_t total = ops_len >= 0 ? static_cast<std::size_t>(ops_len) : 0;
  if (total < 4) {
    return error_response("batch buffer too small");
  }

  std::vector<BatchOp> batch;
  std::size_t cursor = 0;
  const std::int32_t count = read_i32(cursor);
  cursor += 4;
  batch.reserve(static_cast<std::size_t>(count > 0 ? count : 0));

  for (std::int32_t i = 0; i < count; ++i) {
    if (cursor + 4 > total) {
      return error_response("batch buffer truncated (key length)");
    }
    const std::int32_t klen = read_i32(cursor);
    cursor += 4;
    if (klen < 0 || cursor + static_cast<std::size_t>(klen) > total) {
      return error_response("batch buffer truncated (key)");
    }
    std::string key(ops + cursor, static_cast<std::size_t>(klen));
    cursor += static_cast<std::size_t>(klen);

    if (cursor + 4 > total) {
      return error_response("batch buffer truncated (value length)");
    }
    const std::int32_t vlen = read_i32(cursor);
    cursor += 4;

    BatchOp op{};
    op.cf_name = tbl->name();
    op.key = std::move(key);
    if (vlen < 0) {
      op.kind = BatchOp::Kind::del;
      op.value = std::nullopt;
    } else {
      if (cursor + static_cast<std::size_t>(vlen) > total) {
        return error_response("batch buffer truncated (value)");
      }
      op.kind = BatchOp::Kind::put;
      op.value = std::string(ops + cursor, static_cast<std::size_t>(vlen));
      cursor += static_cast<std::size_t>(vlen);
    }
    batch.push_back(std::move(op));
  }

  VoidResult r = db->batch(batch);
  if (!r) {
    return error_response(r.error());
  }
  return ok_response();
}

char* celer_compact(const char* scope, const char* table) {
  auto db = celer::db(scope != nullptr ? scope : "");
  if (!db) {
    return error_response(db.error());
  }
  auto tbl = db->table(table != nullptr ? table : "");
  if (!tbl) {
    return error_response(tbl.error());
  }
  VoidResult r = tbl->compact();
  if (!r) {
    return error_response(r.error());
  }
  return ok_response();
}

void celer_free(char* ptr) { std::free(ptr); }

}  // extern "C"
