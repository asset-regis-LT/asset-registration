#!/usr/bin/env python3
"""Phase 2: add pbsCanonical / subsistemCanonical / namaAsetCanonical / unitLabel
to every inspection record, from data/pbs-crosswalk.csv. Never touches nomorPBS,
subsistem, namaAset, tagNo, fotoPath, inspectionId - so QR / filenames are safe.

Run against a `data`-branch worktree:
  git worktree add -B data /tmp/dw origin/data
  python3 scripts/backfill-canonical-pbs.py /tmp/dw/data/inspections
"""
import csv
import json
import glob
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
INSPECTIONS = Path(sys.argv[1]) if len(sys.argv) > 1 else REPO / "data" / "inspections"
CROSSWALK = REPO / "data" / "pbs-crosswalk.csv"
NEW_FIELDS = ("pbsCanonical", "subsistemCanonical", "namaAsetCanonical", "unitLabel")

xw = {}
with open(CROSSWALK, encoding="utf-8-sig") as f:
    for r in csv.DictReader(f):
        xw[(r["recorded_nomorPBS"], r["recorded_namaAset"])] = r

files = sorted(glob.glob(str(INSPECTIONS / "*.json")))
missing, written = [], 0
for path in files:
    d = json.load(open(path, encoding="utf-8"))
    key = (str(d.get("nomorPBS", "")).strip(), str(d.get("namaAset", "")).strip())
    row = xw.get(key)
    if row is None:
        missing.append((Path(path).name, key))
        continue
    for src, dst in zip(("pbsCanonical", "subsistemCanonical", "namaAsetCanonical", "unitLabel"), NEW_FIELDS):
        d[dst] = row[src]
    Path(path).write_text(json.dumps(d, indent=2, ensure_ascii=False), encoding="utf-8")
    written += 1

if missing:
    print(f"ABORT - {len(missing)} record(s) not in crosswalk:")
    for name, key in missing[:30]:
        print(f"  {name}  {key}")
    sys.exit(1)

print(f"OK - {written}/{len(files)} records updated with {NEW_FIELDS}")
