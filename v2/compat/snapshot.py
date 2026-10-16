#!/usr/bin/env python3
"""Snapshot every read endpoint backed by durable storage. usage: snapshot.py <base> <out.json>"""
import json
import sys
import urllib.request

BASE, OUT = sys.argv[1], sys.argv[2]


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=20) as r:
        body = r.read().decode("utf8")
        try:
            return r.status, json.loads(body)
        except ValueError:
            return r.status, body


snap = {}
for path in ["/api/review/agent/runs", "/api/cdp/retv/runs", "/api/review/sessions",
             "/api/team/connections", "/api/team/integrations", "/api/cdp/retv/config"]:
    snap[path] = get(path)

runs = snap["/api/review/agent/runs"][1]
runs = runs.get("runs", runs) if isinstance(runs, dict) else runs
for run in (runs or []):
    rid = run.get("runId") if isinstance(run, dict) else None
    if rid:
        for suffix in ["", "/report"]:
            snap[f"/api/review/agent/runs/{rid}{suffix}"] = get(f"/api/review/agent/runs/{rid}{suffix}")

retv = snap["/api/cdp/retv/runs"][1]
retv = retv.get("runs", retv) if isinstance(retv, dict) else retv
for run in (retv or []):
    rid = run.get("runId") if isinstance(run, dict) else None
    if rid:
        snap[f"/api/cdp/retv/runs/{rid}"] = get(f"/api/cdp/retv/runs/{rid}")

json.dump(snap, open(OUT, "w"), indent=1, sort_keys=True)
print(f"{len(snap)} endpoints, {len(runs or [])} review runs, {len(retv or [])} retv runs -> {OUT}")
