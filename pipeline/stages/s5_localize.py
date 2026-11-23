"""Stage 5 — Localise detections in 3D, fuse multi-view duplicates, attach chainage (km).

Input   02_frames/frames.json, 04_detect/detections.json
        (optional) previous campaign's 06_assess/defects.json for ID tracking
Output  05_localize/defects.json

Method (PoC level):
  1. Ray from the camera through the bbox centre, using the GNSS/gimbal pose prior.
     Intersect with a simple structure model: the side face of the viaduct (vertical plane
     parallel to the track) for oblique views, or the deck plane for nadir views.
     -> Production: use refined poses from 03_recon/opensfm/reconstruction.json and ray-cast
        on the reconstructed mesh (trimesh / Open3D). Interface stays the same.
  2. Pixel size -> millimetres with the ground-sample distance at the hit point.
  3. Fuse detections of the same class closer than `cluster_radius_m` (one defect seen in many frames).
  4. Linear referencing: chainage, lateral offset, 200 m section.
  5. Match with last campaign's defects (same class, < `match_radius_m`) to keep a stable ID,
     which is what makes deterioration trends possible.
"""
from __future__ import annotations

import math

from ..core import Context, Detection, log, read_json, write_json
from ..geo import from_enu, haversine


def ray_hit(frame: dict, det: Detection, cam: dict, line, face_half_width: float, deck_z: float):
    """Return (lon, lat, z, range_m) of the ray / structure intersection, or None."""
    W, H = cam["width"], cam["height"]
    f = (W / 2) / math.tan(math.radians(cam["hfov_deg"]) / 2)
    u = (det.bbox[0] + det.bbox[2]) / 2
    v = (det.bbox[1] + det.bbox[3]) / 2
    x, y = (u - W / 2) / f, (v - H / 2) / f
    yaw, pitch = math.radians(frame["yaw"]), math.radians(frame["gimbal_pitch"])
    fwd = (math.sin(yaw) * math.cos(pitch), math.cos(yaw) * math.cos(pitch), math.sin(pitch))
    right = (math.cos(yaw), -math.sin(yaw), 0.0)
    up = (right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0])
    d = tuple(fwd[i] + x * right[i] - y * up[i] for i in range(3))
    n = math.sqrt(sum(c * c for c in d))
    d = tuple(c / n for c in d)

    lon0, lat0, z0 = frame["lon"], frame["lat"], frame["alt"]
    t = None
    if d[2] < -0.6:                                   # looking mostly down -> deck plane
        t = (deck_z - z0) / d[2]
    else:                                             # oblique -> side face of the structure
        pr = line.project(lon0, lat0)
        b = math.radians(pr.bearing_deg)
        lat_dir = (math.cos(b), -math.sin(b))         # unit vector to the right of the track
        side = 1.0 if pr.offset_m >= 0 else -1.0
        dn = d[0] * lat_dir[0] + d[1] * lat_dir[1]
        if abs(dn) > 1e-3:
            t = (side * face_half_width - pr.offset_m) / dn
    if t is None or t <= 0 or t > 300:
        return None
    lon, lat = from_enu(d[0] * t, d[1] * t, lon0, lat0)
    return lon, lat, z0 + d[2] * t, t


def run(ctx: Context) -> None:
    lcfg, cam = ctx.cfg["localize"], ctx.cfg["camera"]
    frames = {f["id"]: f for f in read_json(ctx.ws / "02_frames" / "frames.json")}
    dets = [Detection(**d) for d in read_json(ctx.ws / "04_detect" / "detections.json")]
    line, L = ctx.line, float(ctx.cfg["section_length_m"])

    # 1-2: geolocate + metric size
    located: list[Detection] = []
    for det in dets:
        fr = frames.get(det.frame_id)
        if not fr or not fr["lat"]:
            continue
        hit = ray_hit(fr, det, cam, line, lcfg["face_half_width_m"], lcfg["deck_height_m"])
        if hit is None:
            continue
        det.lon, det.lat, det.z, rng = hit
        det.gsd_mm = rng * 2 * math.tan(math.radians(cam["hfov_deg"]) / 2) / cam["width"] * 1000
        located.append(det)
    log.info("localize: %d/%d detections geolocated", len(located), len(dets))

    # 3: greedy multi-view fusion (highest confidence first)
    clusters: list[dict] = []
    for det in sorted(located, key=lambda d: -d.conf):
        for c in clusters:
            if c["type"] == det.cls and haversine((c["lon"], c["lat"]), (det.lon, det.lat)) < lcfg["cluster_radius_m"]:
                c["members"].append(det)
                break
        else:
            clusters.append({"type": det.cls, "lon": det.lon, "lat": det.lat, "members": [det]})

    prev_path = None
    if ctx.cfg.get("previous_campaign"):
        prev_path = ctx.ws.parent / ctx.cfg["previous_campaign"] / "06_assess" / "defects.json"
    previous = read_json(prev_path) if prev_path and prev_path.exists() else []
    used_prev: set[str] = set()
    out = []
    for k, c in enumerate(clusters):
        ms = c["members"]
        wsum = sum(m.conf for m in ms)
        lon = sum(m.lon * m.conf for m in ms) / wsum
        lat = sum(m.lat * m.conf for m in ms) / wsum
        z = sum(m.z * m.conf for m in ms) / wsum
        best = ms[0]                                   # highest confidence view
        fr = frames[best.frame_id]
        pr = line.project(lon, lat)
        med = lambda xs: sorted(xs)[len(xs) // 2]      # noqa: E731
        length_mm = med([m.length_px * m.gsd_mm for m in ms])
        width_mm = med([m.width_px * m.gsd_mm for m in ms])
        area_cm2 = med([m.mask_area_px * (m.gsd_mm / 10) ** 2 for m in ms])

        # 5: keep IDs stable across campaigns
        did = None
        for p in previous:
            if p["id"] not in used_prev and p["type"] == c["type"] and \
                    haversine((p["lon"], p["lat"]), (lon, lat)) < lcfg["match_radius_m"]:
                did = p["id"]
                used_prev.add(did)
                break
        out.append({
            "id": did or f"D-{ctx.campaign}-{k + 1:04d}",
            "type": c["type"], "lon": round(lon, 7), "lat": round(lat, 7), "z": round(z, 2),
            "km": round(pr.chainage_m / 1000, 3), "offset_m": round(pr.offset_m, 2), "bearing": round(pr.bearing_deg, 1),
            "section_idx": int(pr.chainage_m // L),
            "conf": round(best.conf, 3), "n_views": len(ms),
            "length_mm": round(length_mm, 1), "width_mm": round(width_mm, 2), "area_cm2": round(area_cm2, 1),
            "frame": {"flight": fr["flight_id"], "t": fr["t"], "image": fr["image"]},
        })
    log.info("localize: %d defects (%d matched to previous campaign)", len(out), len(used_prev))
    write_json(ctx.stage_dir("05_localize") / "defects.json", out)
