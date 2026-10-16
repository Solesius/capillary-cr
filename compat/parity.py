#!/usr/bin/env python3
"""Behavior-parity probe: replay one request script against two servers, diff the results.

Compares what a client depends on — status, media type, normalized body,
cookie names/attributes, content-disposition, CORS and Allow — not header
casing, ETag format or hop-by-hop headers. Differences listed in INTENDED are
deliberate v2 behavior and reported separately.

usage: parity.py <phase> <base_a> <base_b>
phase: gate (login required, image defaults) | open (login gate disabled)
"""
import http.client
import json
import re
import socket
import sys
from urllib.parse import urlparse

PHASE, A, B = sys.argv[1], sys.argv[2], sys.argv[3]

HEADERS_OF_INTEREST = [
    "content-type", "content-length", "cache-control", "allow", "vary",
    "access-control-allow-origin", "access-control-allow-headers",
    "access-control-allow-methods", "content-disposition", "set-cookie",
    "x-powered-by", "location", "content-range",
]

GET_ROUTES = """
/api/artifacts/r1/graph
/api/artifacts/r1/markdown
/api/cdp/retv/config
/api/cdp/retv/run/stream
/api/cdp/retv/runs
/api/cdp/retv/runs/r1
/api/cdp/retv/runs/r1/driver
/api/cdp/retv/runs/r1/export
/api/cdp/retv/runs/r1/report
/api/cdp/sessions
/api/github/app/callback
/api/github/app/manifest
/api/github/oauth/callback?code=x&state=y
/api/github/oauth/poll/s1
/api/github/repositories
/api/github/repositories/123/pull-requests
/api/github/repositories/123/pull-requests/9
/api/github/repositories/lookup?name=a/b
/api/review/agent/runs
/api/review/agent/runs/r1
/api/review/agent/runs/r1/export
/api/review/agent/runs/r1/report
/api/review/runs/r1
/api/review/runs/r1/checklist
/api/review/runs/r1/events
/api/review/runs/r1/findings
/api/review/sessions
/api/review/sessions/r1/stream
/api/team/connections
/api/team/integrations
/api/team/me
""".split()

POST_ROUTES = """
/api/cdp/browser/open
/api/cdp/retv/config
/api/cdp/retv/run
/api/cdp/retv/runs/r1/cancel
/api/cdp/sessions
/api/cdp/sessions/s1/work-units
/api/github/connect
/api/github/webhook
/api/integrations/slack/command
/api/review/runs
/api/review/runs/r1/cancel
/api/review/runs/r1/check-changes
/api/review/runs/r1/findings/f1/comment
/api/review/runs/r1/findings/f1/dispatch
/api/review/runs/r1/findings/f1/jira
/api/review/runs/r1/findings/f1/suggestion
/api/review/runs/r1/pr-comment
/api/review/runs/async
/api/review/sessions
/api/team/connections
/api/team/connections/c1/test
/api/team/me/github
""".split()


def script():
    yield ("GET", "/healthz", None, {})
    yield ("HEAD", "/healthz", None, {})
    yield ("OPTIONS", "/api/review/runs", None, {"Origin": "http://localhost:8080"})
    yield ("OPTIONS", "/api/review/runs", None, {"Origin": "https://evil.example"})
    yield ("POST", "/api/review/runs", b"{}", {"Origin": "https://evil.example", "Content-Type": "application/json"})
    yield ("POST", "/api/review/runs", b"{}", {"Origin": "http://localhost:8080", "Content-Type": "application/json"})
    yield ("GET", "/", None, {})
    yield ("HEAD", "/", None, {})
    yield ("GET", "/index.html", None, {})
    yield ("GET", "/review/123/deep/link", None, {})
    yield ("GET", "/.env", None, {})
    yield ("GET", "/../../etc/passwd", None, {})
    yield ("GET", "/%2e%2e/%2e%2e/etc/passwd", None, {})
    yield ("POST", "/some/page", b"x", {})
    yield ("GET", "/polyfills.js", None, {})
    yield ("GET", "/styles.css", None, {})
    yield ("GET", "/polyfills.js", None, {"Range": "bytes=0-99"})
    yield ("GET", "/polyfills.js", None, {"Range": "bytes=999999-"})
    yield ("GET", "/x/../index.html", None, {})
    yield ("GET", "/api/does-not-exist", None, {})
    yield ("GET", "/api/github/oauth/start?webOrigin=http://localhost:8080", None, {})
    if PHASE == "open":
        for path in GET_ROUTES:
            yield ("GET", path, None, {})
        for path in POST_ROUTES:
            yield ("POST", path, b"{}", {"Content-Type": "application/json"})
            yield ("POST", path, b"not json", {"Content-Type": "application/json"})
            yield ("POST", path, b"", {})
        yield ("PATCH", "/api/team/connections/c1", b"{}", {"Content-Type": "application/json"})
        yield ("DELETE", "/api/team/connections/c1", None, {})
        yield ("DELETE", "/api/cdp/sessions/s1", None, {})
        yield ("DELETE", "/api/team/me/github", None, {})
        yield ("PUT", "/api/review/runs", b"{}", {})
        yield ("DELETE", "/api/review/sessions", None, {})
        yield ("GET", "/api/review/runs/stream?pullRequestId=", None, {"Accept": "text/event-stream"})
        yield ("GET", "/api/review/runs/R1/", None, {})
        yield ("GET", "/API/REVIEW/SESSIONS", None, {})
        yield ("GET", "/api/review/runs/r%201", None, {})


def norm_body(body: bytes, ctype: str) -> str:
    text = body.decode("utf8", "replace")
    text = re.sub(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", "<uuid>", text)
    text = re.sub(r"\b[0-9a-f]{32}\b", "<hex32>", text)
    text = re.sub(r"\b[0-9A-F]{4}-[0-9A-F]{4}\b", "<usercode>", text)
    text = re.sub(r"\bcdp_[0-9a-f]{8}\b", "<cdp-session>", text)
    text = re.sub(r"\b[0-9A-F]{32}\b", "<cdp-target>", text)
    text = re.sub(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z", "<ts>", text)
    if "json" in ctype:
        try:
            return json.dumps(json.loads(text), sort_keys=True)
        except ValueError:
            return text
    return text


def send(base, method, path, body, headers):
    url = urlparse(base)
    conn = http.client.HTTPConnection(url.hostname, url.port, timeout=6)
    sent = {"Host": f"localhost:8080", **headers}
    if body is not None:
        sent["Content-Length"] = str(len(body))
    conn.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
    for k, v in sent.items():
        conn.putheader(k, v)
    conn.endheaders(body)
    resp = conn.getresponse()
    hdrs = {k.lower(): v for k, v in resp.getheaders()}
    try:
        if hdrs.get("content-type", "").startswith("text/event-stream"):
            data = b""
            conn.sock.settimeout(3)
            try:
                while len(data) < 4096:
                    chunk = resp.read1(4096)
                    if not chunk:
                        break
                    data += chunk
            except (socket.timeout, TimeoutError):
                data += b"<timeout>"
        else:
            data = resp.read() if method != "HEAD" else b""
    finally:
        conn.close()
    picked = {}
    for h in HEADERS_OF_INTEREST:
        if h not in hdrs:
            continue
        value = hdrs[h]
        if h == "content-type":
            value = value.split(";")[0].strip().lower()
        elif h == "set-cookie":
            name, _, attrs = value.partition(";")
            value = name.split("=")[0] + ";" + ";".join(sorted(a.strip().lower() for a in attrs.split(";") if a.strip()))
        elif h == "allow":
            value = ",".join(sorted(m.strip() for m in value.split(",")))
        elif h in ("content-length", "etag", "cache-control", "vary"):
            continue
        picked[h] = value
    return resp.status, picked, norm_body(data, hdrs.get("content-type", ""))


# Deliberate v2 behavior (method, path-prefix) -> why. Reported, not failed.
INTENDED = {
    ("GET", "/api/does-not-exist"): "unknown API path: JSON 404 body instead of an empty one",
    ("PUT", "/api/review/runs"): "405 now carries {error: method_not_allowed}",
    ("DELETE", "/api/review/sessions"): "405 now carries {error: method_not_allowed}",
    ("POST", "/some/page"): "SPA fallback answers GET/HEAD only; other methods are a JSON 404",
}
INTENDED_BODIES = {
    b"not json": "malformed JSON is 400 invalid_json (was an opaque 500)",
    b"": "an empty JSON body is read as {} (was an opaque 500)",
}

diffs = 0
intended = 0
total = 0
for method, path, body, headers in script():
    total += 1
    ra = send(A, method, path, body, headers)
    rb = send(B, method, path, body, headers)
    if ra == rb:
        continue
    reason = INTENDED.get((method, path.split("?")[0]))
    if reason is None and body in INTENDED_BODIES and ra[0] == 500:
        reason = INTENDED_BODIES[body]
    if reason is None and "Range" in headers and ra[0] == rb[0] == 416:
        reason = "unsatisfiable range: RFC 9110 Content-Range */size, no body (v1 sent the whole file)"
    if reason is None and method == "GET" and path.startswith("/api/artifacts/") and ra[0] == rb[0]:
        reason = "error responses are JSON (v1 kept the handler's markdown content-type)"
    label = "INTENDED" if reason else "DIFF"
    if reason:
        intended += 1
    else:
        diffs += 1
    print(f"--- [{label}] {method} {path} {headers} body={body!r}" + (f"\n  why: {reason}" if reason else ""))
    if ra[0] != rb[0]:
        print(f"  status: v1={ra[0]} v2={rb[0]}")
    for h in sorted(set(ra[1]) | set(rb[1])):
        if ra[1].get(h) != rb[1].get(h):
            print(f"  {h}: v1={ra[1].get(h)!r} v2={rb[1].get(h)!r}")
    if ra[2] != rb[2]:
        print(f"  body v1: {ra[2][:300]!r}")
        print(f"  body v2: {rb[2][:300]!r}")
print(f"\n{PHASE}: {total} requests, {diffs} unexpected differences, {intended} intended")
sys.exit(1 if diffs else 0)
