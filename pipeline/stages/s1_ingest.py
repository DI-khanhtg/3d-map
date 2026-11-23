"""Stage 1 — Ingest: inventory raw drone media and extract position metadata.

Input   <workspace>/<campaign>/raw/<flight_id>/*.MP4|*.MOV (+ same-name .SRT) and *.JPG
Output  01_ingest/manifest.json   list[Media]

Why the .SRT matters: DJI drones write a subtitle file next to every video with one GNSS
fix per frame (lat/lon/altitude, sometimes gimbal angles). That is what lets us geotag
frames cut from video without running SfM first.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

from ..core import Context, Media, log, write_json

VIDEO_EXT = {".mp4", ".mov"}
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".dng"}

# DJI SRT variants seen in the wild:
#   [latitude: 35.674100] [longitude: 139.761900] [rel_alt: 30.000 abs_alt: 65.200]
#   GPS(139.7619,35.6741,30.0)  (older models)
_RE_LAT = re.compile(r"latitude\s*:\s*(-?\d+\.\d+)")
_RE_LON = re.compile(r"longitude\s*:\s*(-?\d+\.\d+)")
_RE_ALT = re.compile(r"rel_alt\s*:\s*(-?\d+\.?\d*)")
_RE_GPS = re.compile(r"GPS\s*\(\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.?\d*)")
_RE_YAW = re.compile(r"(?:gb_yaw|yaw)\s*:\s*(-?\d+\.?\d*)")
_RE_GPITCH = re.compile(r"gb_pitch\s*:\s*(-?\d+\.?\d*)")
_RE_TIME = re.compile(r"(\d+):(\d+):(\d+)[,.](\d+)\s*-->")


def parse_dji_srt(path: Path) -> list[dict]:
    track: list[dict] = []
    for block in path.read_text(encoding="utf-8", errors="ignore").split("\n\n"):
        tm = _RE_TIME.search(block)
        if not tm:
            continue
        h, m, s, ms = (int(x) for x in tm.groups())
        t = h * 3600 + m * 60 + s + ms / 1000
        lat = lon = alt = None
        if (mla := _RE_LAT.search(block)) and (mlo := _RE_LON.search(block)):
            lat, lon = float(mla.group(1)), float(mlo.group(1))
            alt = float(ma.group(1)) if (ma := _RE_ALT.search(block)) else 0.0
        elif mg := _RE_GPS.search(block):
            lon, lat, alt = float(mg.group(1)), float(mg.group(2)), float(mg.group(3))
        if lat is None:
            continue
        yaw = float(my.group(1)) if (my := _RE_YAW.search(block)) else 0.0
        gp = float(mp.group(1)) if (mp := _RE_GPITCH.search(block)) else 0.0
        track.append({"t": t, "lat": lat, "lon": lon, "alt": alt, "yaw": yaw, "gimbal_pitch": gp})
    return track


def probe_video(path: Path) -> dict:
    """Resolution / fps / duration via ffprobe (part of FFmpeg)."""
    if not shutil.which("ffprobe"):
        log.warning("ffprobe not found - video metadata left empty for %s", path.name)
        return {}
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=width,height,r_frame_rate:format=duration", "-of", "json", str(path)],
        capture_output=True, text=True, check=True).stdout
    info = json.loads(out)
    st = info["streams"][0]
    num, den = (int(x) for x in st["r_frame_rate"].split("/"))
    return {"width": st["width"], "height": st["height"], "fps": num / den if den else 0.0,
            "duration_s": float(info["format"]["duration"])}


_RE_XMP = {
    "alt": re.compile(rb'drone-dji:RelativeAltitude="([+-]?\d+\.?\d*)"'),
    "yaw": re.compile(rb'drone-dji:FlightYawDegree="([+-]?\d+\.?\d*)"'),
    "gimbal_pitch": re.compile(rb'drone-dji:GimbalPitchDegree="([+-]?\d+\.?\d*)"'),
    "lat": re.compile(rb'drone-dji:GpsLatitude="([+-]?\d+\.?\d*)"'),
    "lon": re.compile(rb'drone-dji:GpsLongi?tude="([+-]?\d+\.?\d*)"'),
}


def read_image_pose(path: Path) -> dict:
    """GNSS + gimbal from DJI XMP (plain text inside the JPEG). Falls back to EXIF via Pillow."""
    head = path.read_bytes()[:256_000]
    pose = {k: float(m.group(1)) for k, rx in _RE_XMP.items() if (m := rx.search(head))}
    if "lat" not in pose:
        try:
            from PIL import Image  # lazy: only needed for non-DJI images
            from PIL.ExifTags import GPSTAGS
            gps = {GPSTAGS.get(k, k): v for k, v in Image.open(path).getexif().get_ifd(0x8825).items()}

            def dms(v, ref):
                d = float(v[0]) + float(v[1]) / 60 + float(v[2]) / 3600
                return -d if ref in ("S", "W") else d
            pose["lat"] = dms(gps["GPSLatitude"], gps.get("GPSLatitudeRef", "N"))
            pose["lon"] = dms(gps["GPSLongitude"], gps.get("GPSLongitudeRef", "E"))
            pose.setdefault("alt", float(gps.get("GPSAltitude", 0)))
        except Exception as e:  # noqa: BLE001 - metadata is best effort
            log.warning("no GNSS in %s (%s)", path.name, e)
    return pose


def run(ctx: Context) -> None:
    if not ctx.raw.exists():
        raise FileNotFoundError(f"raw media folder not found: {ctx.raw}")
    media: list[Media] = []
    for flight_dir in sorted(p for p in ctx.raw.iterdir() if p.is_dir()):
        for f in sorted(flight_dir.iterdir()):
            ext = f.suffix.lower()
            if ext in VIDEO_EXT:
                srt = f.with_suffix(".SRT") if f.with_suffix(".SRT").exists() else f.with_suffix(".srt")
                track = parse_dji_srt(srt) if srt.exists() else []
                if not track:
                    log.warning("%s: no .SRT track - frames will rely on SfM for position", f.name)
                media.append(Media(path=str(f), kind="video", flight_id=flight_dir.name, track=track, **probe_video(f)))
            elif ext in IMAGE_EXT:
                pose = read_image_pose(f)
                track = [{"t": 0.0, **pose}] if "lat" in pose else []
                media.append(Media(path=str(f), kind="image", flight_id=flight_dir.name, track=track))
    n_vid = sum(m.kind == "video" for m in media)
    log.info("ingest: %d videos, %d images, %d flights", n_vid, len(media) - n_vid, len({m.flight_id for m in media}))
    write_json(ctx.stage_dir("01_ingest") / "manifest.json", media)
