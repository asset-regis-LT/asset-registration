#!/usr/bin/env python3
"""Regenerate data/master-catalog.json from a PBS master Excel file.

Usage: python3 scripts/import-pbs-master.py [path/to/PBS_MASTER_INPUT.xlsx]

Expects a sheet with columns (Kode PBS, Level, Jenis, Komponen) where Level 1
rows are Sistem/Area, Level 2 rows are Sub-sistem, and Level 3 rows are the
Komponen/Peralatan that become catalog assets. Each Level 3 row is expanded
into one row per smelter (LOKASI below), matching the app's existing model of
"same asset, one row per site it's installed at".
"""
import json
import sys
from pathlib import Path

import openpyxl

REPO_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_PATH = REPO_ROOT / "data" / "master-catalog.json"

LOKASI = [
    "Refined Bangka Tin (RBT)",
    "Tinindo Inter Nusa (TIN)",
    "Venus Inti Perkasa (VIP)",
    "Stanindo Inti Perkasa (SIP)",
    "Sariwiguna Bina Sentosa (SBS)",
    "Menara Cipta Mulia (MCM)",
]


def load_components(xlsx_path):
    wb = openpyxl.load_workbook(xlsx_path, data_only=True)
    ws = wb.worksheets[0]
    rows = list(ws.iter_rows(values_only=True))[2:]  # skip title + header row

    components = []
    current_subsistem = None
    for kode_pbs, level, jenis, komponen in rows:
        if level == 2:
            current_subsistem = komponen
        elif level == 3:
            components.append({"nomorPBS": str(kode_pbs), "subsistem": current_subsistem, "namaAset": komponen})
    return components


def build_catalog(components):
    catalog = []
    for comp in components:
        for lokasi in LOKASI:
            catalog.append({
                "nomorPBS": comp["nomorPBS"],
                "subsistem": comp["subsistem"],
                "namaAset": comp["namaAset"],
                "lokasi": lokasi,
                "subKomponen": [],
            })
    return catalog


def main():
    xlsx_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / "Downloads" / "PBS_MASTER_INPUT.xlsx"
    components = load_components(xlsx_path)
    catalog = build_catalog(components)
    OUTPUT_PATH.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(catalog)} rows ({len(components)} components x {len(LOKASI)} lokasi) to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
