"""Stage 7 — Export for the 3D viewer and for reporting.

Input   06_assess/defects.json, rail line, asset register, catalog
Output  viewer data file (config export.viewer_js)  window.INSPECTION = {...}  schema rail-inspection/0.1
        07_export/defects.geojson   (GIS / asset management systems)
        07_export/defects.csv       (inspection report / Excel)
Optional (not implemented here): copy 03_recon/.../3d_tiles into the viewer and add a
deck.gl Tile3DLayer to show the real reconstructed model instead of the synthetic point cloud.
"""
from __future__ import annotations

import csv

from ..core import Context, ROOT, log, read_json, write_js_var, write_json
from .s6_assess import asset_at, grade_of, risk_score


def run(ctx: Context) -> None:
    catalog = read_json(ROOT / ctx.cfg["catalog"])
    grades = sorted(catalog["grades"], key=lambda g: -g["min"])
    reg_path = ROOT / ctx.cfg["assets_register"] if ctx.cfg.get("assets_register") else None
    register = read_json(reg_path) if reg_path and reg_path.exists() else []
    campaigns = [c for c in ctx.cfg["campaigns"]]
    cids = [c["id"] for c in campaigns]
    line, meta = ctx.line, ctx.line_meta
    L = float(ctx.cfg["section_length_m"])
    stations = sorted(meta["stations"], key=lambda s: s["km"])

    # ---- defects: arrays aligned with `campaigns`
    defects = []
    for d in read_json(ctx.ws / "06_assess" / "defects.json"):
        obs, risk, grade, prev_sev = [], [], [], None
        for cid in cids:
            o = d["history"].get(cid)
            if o is None:
                obs.append(None); risk.append(None); grade.append(None)
                prev_sev = None
                continue
            r = risk_score(o["sev"], prev_sev, d["crit"])
            obs.append(o); risk.append(r); grade.append(grade_of(r, grades))
            prev_sev = o["sev"]
        defects.append({
            "id": d["id"], "section": f"{meta['id']}-S{d['section_idx']:03d}", "km": d["km"],
            "lon": d["lon"], "lat": d["lat"], "z": d["z"], "bearing": d["bearing"],
            "type": d["type"], "component": d["component"], "asset": d["asset"], "crit": d["crit"],
            "story": False, "note": "", "obs": obs, "risk": risk, "grade": grade,
        })

    # ---- sections
    def between(s_m: float) -> list[str]:
        prev = stations[-1]["name"]
        nxt = stations[0]["name"]
        for st in stations:
            if st["km"] * 1000 <= s_m:
                prev = st["name"]
        for st in stations:
            if st["km"] * 1000 > s_m:
                nxt = st["name"]
                break
        return [prev, nxt]

    sections = []
    n = int(-(-line.length // L))
    for k in range(n):
        s0, s1 = k * L, min(line.length, (k + 1) * L)
        reg = asset_at((s0 + s1) / 2000, register, catalog.get("default_asset", "earthwork"))
        h = catalog["asset_types"][reg["asset"]]["height_m"]
        pts = [line.point_at(s0)] + [(*line.coords[i], 0) for i in range(len(line.cum)) if s0 < line.cum[i] < s1] \
            + [line.point_at(s1 - 0.01)]
        sid = f"{meta['id']}-S{k:03d}"
        mine = [d for d in defects if d["section"] == sid]
        srisk = [max([0.05] + [d["risk"][c] for d in mine if d["risk"][c] is not None]) for c in range(len(cids))]
        sections.append({
            "id": sid, "idx": k, "from_km": round(s0 / 1000, 3), "to_km": round(s1 / 1000, 3),
            "between": between((s0 + s1) / 2), "asset": reg["asset"], "asset_label": reg.get("label"), "height_m": h,
            "path": [[round(p[0], 6), round(p[1], 6), h] for p in pts],
            "risk": srisk, "grade": [grade_of(r, grades) for r in srisk], "defects": [d["id"] for d in mine],
        })

    data = {
        "schema": "rail-inspection/0.1", "generated_by": "pipeline/run.py", "mock": ctx.cfg["detect"].get("kind") == "mock",
        "line": {"id": meta["id"], "name": meta["name"], "name_en": meta.get("name_en"), "city": meta.get("city")},
        "section_length_m": L, "campaigns": campaigns,
        "defect_types": catalog["defect_types"], "asset_types": catalog["asset_types"], "grades": catalog["grades"],
        "risk_formula": "risk = 0.8*severity*(0.6+0.4*criticality) + 0.2*growth",
        "sections": sections, "defects": defects,
    }
    write_js_var(ROOT / ctx.cfg["export"]["viewer_js"], "INSPECTION", data)

    out = ctx.stage_dir("07_export")
    last = len(cids) - 1
    write_json(out / "defects.geojson", {"type": "FeatureCollection", "features": [{
        "type": "Feature", "geometry": {"type": "Point", "coordinates": [d["lon"], d["lat"], d["z"]]},
        "properties": {k: d[k] for k in ("id", "section", "km", "type", "component", "asset")} |
                      {"risk": d["risk"][last], "grade": d["grade"][last]}} for d in defects]})
    with open(out / "defects.csv", "w", newline="", encoding="utf-8-sig") as fh:   # BOM so Excel (JP) opens UTF-8
        w = csv.writer(fh)
        w.writerow(["id", "section", "km", "type", "component", "asset", "risk", "grade", "value", "conf", "flight", "t"])
        for d in sorted(defects, key=lambda d: -(d["risk"][last] or 0)):
            o = d["obs"][last] or {}
            w.writerow([d["id"], d["section"], d["km"], d["type"], d["component"], d["asset"], d["risk"][last],
                        d["grade"][last], o.get("value"), o.get("conf"), (o.get("frame") or {}).get("flight"),
                        (o.get("frame") or {}).get("t")])
    log.info("export: %d sections, %d defects", len(sections), len(defects))
