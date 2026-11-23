"""Stage 2 — Keyframe selection: turn hours of video into a compact, sharp, geotagged image set.

Input   01_ingest/manifest.json
Output  02_frames/images/*.jpg
        02_frames/frames.json   list[Frame]
        02_frames/geo.txt       GNSS priors in OpenDroneMap's geo.txt format

Rules (tunable in config.keyframes):
  * spacing   - keep a frame every `min_spacing_m` metres of drone travel (≈ 80 % overlap
                at typical inspection distance); falls back to `fallback_every_s` without GNSS
  * sharpness - drop motion-blurred frames (variance of Laplacian < `min_sharpness`)
Requires: opencv-python
"""
from __future__ import annotations

import bisect
from pathlib import Path

from ..core import Context, Frame, log, read_json, write_json
from ..geo import haversine


def interp_track(track: list[dict], t: float) -> dict | None:
    if not track:
        return None
    ts = [p["t"] for p in track]
    i = bisect.bisect_left(ts, t)
    if i <= 0:
        return track[0]
    if i >= len(track):
        return track[-1]
    a, b = track[i - 1], track[i]
    k = 0.0 if b["t"] == a["t"] else (t - a["t"]) / (b["t"] - a["t"])
    return {key: a[key] + (b[key] - a[key]) * k for key in ("lat", "lon", "alt", "yaw", "gimbal_pitch") if key in a and key in b}


def run(ctx: Context) -> None:
    import cv2  # lazy import so other stages work without OpenCV

    kcfg = ctx.cfg["keyframes"]
    out_dir = ctx.stage_dir("02_frames")
    img_dir = out_dir / "images"
    img_dir.mkdir(exist_ok=True)
    frames: list[Frame] = []

    for m in read_json(ctx.ws / "01_ingest" / "manifest.json"):
        if m["kind"] == "image":
            p = m["track"][0] if m["track"] else {}
            img = cv2.imread(m["path"], cv2.IMREAD_GRAYSCALE)
            sharp = float(cv2.Laplacian(img, cv2.CV_64F).var()) if img is not None else 0.0
            frames.append(Frame(id=Path(m["path"]).stem, image=m["path"], flight_id=m["flight_id"], t=0.0,
                                lat=p.get("lat", 0.0), lon=p.get("lon", 0.0), alt=p.get("alt", 0.0),
                                yaw=p.get("yaw", 0.0), gimbal_pitch=p.get("gimbal_pitch", -90.0), sharpness=sharp))
            continue

        cap = cv2.VideoCapture(m["path"])
        fps = cap.get(cv2.CAP_PROP_FPS) or m.get("fps") or 30.0
        last_pos, last_t, idx, kept = None, -1e9, 0, 0
        while True:
            ok = cap.grab()                       # grab() is cheap; decode only candidates
            if not ok:
                break
            t = idx / fps
            idx += 1
            pose = interp_track(m["track"], t)
            if pose:
                pos = (pose["lon"], pose["lat"])
                if last_pos is not None and haversine(last_pos, pos) < kcfg["min_spacing_m"]:
                    continue
            elif t - last_t < kcfg["fallback_every_s"]:
                continue
            ok, bgr = cap.retrieve()
            if not ok:
                continue
            sharp = float(cv2.Laplacian(cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var())
            if sharp < kcfg["min_sharpness"]:
                continue                          # blurred - try the next frame
            fid = f"{m['flight_id']}_{t:08.2f}"
            path = img_dir / f"{fid}.jpg"
            cv2.imwrite(str(path), bgr, [cv2.IMWRITE_JPEG_QUALITY, 95])
            p = pose or {}
            frames.append(Frame(id=fid, image=str(path), flight_id=m["flight_id"], t=round(t, 2),
                                lat=p.get("lat", 0.0), lon=p.get("lon", 0.0), alt=p.get("alt", 0.0),
                                yaw=p.get("yaw", 0.0), gimbal_pitch=p.get("gimbal_pitch", 0.0), sharpness=sharp))
            last_pos = (p["lon"], p["lat"]) if pose else None
            last_t = t
            kept += 1
        cap.release()
        log.info("%s: %d frames scanned -> %d keyframes", Path(m["path"]).name, idx, kept)

    write_json(out_dir / "frames.json", frames)
    # OpenDroneMap geo.txt: first line = CRS, then "image lon lat alt [yaw pitch roll]"
    lines = ["EPSG:4326"] + [f"{Path(f.image).name} {f.lon:.8f} {f.lat:.8f} {f.alt:.2f} {f.yaw:.1f} {f.gimbal_pitch:.1f} 0"
                             for f in frames if f.lat]
    (out_dir / "geo.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    log.info("keyframes: %d total", len(frames))
