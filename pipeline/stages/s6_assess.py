"""Stage 6 — Assessment: severity, component, history merge, risk score and grade proposal.

Input   05_localize/defects.json, previous campaign 06_assess/defects.json, asset register, catalog
Output  06_assess/defects.json   (one record per defect, with `history` keyed by campaign id)

risk = 0.8 * severity * (0.6 + 0.4 * criticality) + 0.2 * growth
  severity    0..1  from measurements (thresholds below are PLACEHOLDERS - to be calibrated
                    with the operator's 健全度 criteria / 維持管理標準 together with their engineers)
  criticality 0..1  importance of the component (橋脚 1.0 ... 高欄 0.4), from the catalog
  growth      0..1  severity increase vs previous campaign (0.3 for a new detection)
Grade (AA/A1/A2/B/C/S) is only a PROPOSAL; an engineer confirms it in the viewer.
"""
from __future__ import annotations

from ..core import Context, log, read_json, write_json, ROOT


def clamp(v: float) -> float:
    return max(0.0, min(1.0, v))


SEVERITY = {
    "crack":    lambda d: clamp(0.5 * d["width_mm"] / 1.0 + 0.5 * d["length_mm"] / 300),
    "spalling": lambda d: clamp(d["area_cm2"] / 900),
    "rebar":    lambda d: clamp(d["length_mm"] / 600),
    "rust":     lambda d: clamp(d["area_cm2"] / 700),
    "leak":     lambda d: clamp(d["area_cm2"] / 1500),
    "deform":   lambda d: clamp(d.get("displacement_mm", 12) / 40),   # needs point-cloud diff (TODO)
    "missing":  lambda d: 0.4,
    # track (rail_crack length from the mask skeleton; ballast = fouled area; sleeper = count of cracked sleepers)
    "rail_crack": lambda d: clamp(d["length_mm"] / 40),
    "ballast":    lambda d: clamp(d.get("area_m2", d.get("area_cm2", 0) / 1e4) / 10),
    "sleeper":    lambda d: clamp(d.get("count", 1) / 8),
    # track geometry from the point cloud: versine (mm) on a 10 m chord; ~30 mm = act now (tune to the operator's limits)
    "track_geom": lambda d: clamp(d.get("versine_mm", 0) / 30),
}
VALUE = {   # value shown in the viewer, in the unit of catalog.defect_types[type].unit
    "crack": lambda d: round(d["length_mm"] / 10, 1), "spalling": lambda d: d["area_cm2"],
    "rebar": lambda d: round(d["length_mm"] / 10, 1), "rust": lambda d: d["area_cm2"],
    "leak": lambda d: d["area_cm2"], "deform": lambda d: d.get("displacement_mm", 0), "missing": lambda d: 1,
    "rail_crack": lambda d: round(d["length_mm"], 1), "ballast": lambda d: round(d.get("area_m2", d.get("area_cm2", 0) / 1e4), 1),
    "sleeper": lambda d: d.get("count", 1), "track_geom": lambda d: round(d.get("versine_mm", 0), 1),
}


def risk_score(sev: float, prev_sev: float | None, crit: float) -> float:
    growth = 0.3 if prev_sev is None else clamp((sev - prev_sev) / 0.3)
    return round(min(1.0, 0.8 * sev * (0.6 + 0.4 * crit) + 0.2 * growth), 3)


def grade_of(risk: float, grades: list[dict]) -> str:
    for g in grades:                       # sorted from AA (highest min) down to S
        if risk >= g["min"]:
            return g["id"]
    return "S"


def asset_at(km: float, register: list[dict], default: str) -> dict:
    for a in register:
        if a["from_km"] <= km <= a["to_km"]:
            return a
    return {"asset": default, "label": None}


def guess_component(asset_def: dict, z: float, defect_type: str) -> tuple[str, float]:
    """Very rough placeholder: pick a component that can host this defect type, using height.
    Production: a component-segmentation model on the 3D mesh, or the operator's BIM/CIM model."""
    comps = [c for c in asset_def["components"] if defect_type in c[2]] or asset_def["components"]
    h = asset_def.get("height_m", 0)
    if h and z > h + 0.5:
        pick = next((c for c in comps if c[0] in ("高欄", "架線柱")), comps[0])
    elif h and z < h * 0.7:
        pick = next((c for c in comps if c[0] in ("橋脚", "橋台")), comps[0])
    else:
        pick = comps[0]
    return pick[0], float(pick[1])


def run(ctx: Context) -> None:
    catalog = read_json(ROOT / ctx.cfg["catalog"])
    reg_path = ROOT / ctx.cfg["assets_register"] if ctx.cfg.get("assets_register") else None
    register = read_json(reg_path) if reg_path and reg_path.exists() else []
    default_asset = catalog.get("default_asset", "earthwork")
    track_comps = set(catalog.get("track_components", []))

    current = read_json(ctx.ws / "05_localize" / "defects.json")
    prev_path = ctx.ws.parent / ctx.cfg["previous_campaign"] / "06_assess" / "defects.json" \
        if ctx.cfg.get("previous_campaign") else None
    previous = {d["id"]: d for d in read_json(prev_path)} if prev_path and prev_path.exists() else {}

    out = []
    for d in current:
        reg = asset_at(d["km"], register, default_asset)
        adef = catalog["asset_types"][reg["asset"]]
        old = previous.get(d["id"], {})
        component, crit = (old["component"], old["crit"]) if old else guess_component(adef, d["z"], d["type"])
        sev = round(SEVERITY[d["type"]](d), 3)
        obs = {"sev": sev, "conf": d["conf"], "value": VALUE[d["type"]](d), "frame": d["frame"],
               "width_mm": d["width_mm"] if d["type"] == "crack" else None, "n_views": d["n_views"]}
        history = dict(old.get("history", {}))
        history[ctx.campaign] = obs
        # track vs structure follows the component (missing bolts on a girder = structure, on a fastening = track)
        cat = "track" if component in track_comps else catalog["defect_types"][d["type"]].get("cat", "structure")
        out.append({**{k: d[k] for k in ("id", "type", "lon", "lat", "z", "km", "bearing", "section_idx")},
                    "asset": reg["asset"], "component": component, "cat": cat, "crit": crit, "history": history})

    # defects seen before but not re-detected this time: keep them (could be repaired, occluded, or missed)
    seen = {d["id"] for d in out}
    carried = [p for pid, p in previous.items() if pid not in seen]
    out.extend(carried)
    log.info("assess: %d defects (%d new/updated, %d carried over without re-detection)",
             len(out), len(current), len(carried))
    write_json(ctx.stage_dir("06_assess") / "defects.json", out)
