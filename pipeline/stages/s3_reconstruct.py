"""Stage 3 — 3D reconstruction (Structure-from-Motion + Multi-View Stereo).

Input   02_frames/images/*.jpg + geo.txt
Output  03_recon/odm/<project>/...  (OpenDroneMap standard layout), notably
          odm_georeferencing/odm_georeferenced_model.laz   dense point cloud (LAS/LAZ)
          odm_texturing/odm_textured_model_geo.obj        textured mesh
          odm_orthophoto/odm_orthophoto.tif               orthophoto (GeoTIFF)
          3d_tiles/                                       OGC 3D Tiles (for Cesium / deck.gl Tile3DLayer)
          opensfm/reconstruction.json                     refined camera poses (used by stage 5)

Engine: OpenDroneMap via Docker (open source, handles GNSS priors, outputs 3D Tiles).
Alternatives to evaluate in the PoC: COLMAP (+ OpenMVS), RealityCapture / Metashape (commercial),
or 3D Gaussian Splatting for photoreal viewing (not metric - keep the mesh for measurement).

Tips for rail viaducts: fly two parallel passes (both sides) + one oblique pass; keep 80/70 %
overlap; add a few GCPs (ground control points) per km if centimetre accuracy is needed.
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from ..core import Context, log, read_json


def run(ctx: Context) -> None:
    rcfg = ctx.cfg["reconstruct"]
    frames_dir = ctx.ws / "02_frames"
    project = rcfg.get("project_name", "recon")
    odm_root = ctx.stage_dir("03_recon") / "odm"
    img_dst = odm_root / project / "images"
    img_dst.mkdir(parents=True, exist_ok=True)

    # ODM wants every image (and geo.txt) in <project>/images
    for f in read_json(frames_dir / "frames.json"):
        src = Path(f["image"])
        dst = img_dst / src.name
        if not dst.exists():
            shutil.copy2(src, dst)
    shutil.copy2(frames_dir / "geo.txt", img_dst / "geo.txt")

    cmd = [
        "docker", "run", "--rm", "-v", f"{odm_root}:/datasets",
        rcfg.get("odm_image", "opendronemap/odm"),
        "--project-path", "/datasets", project,
        "--geo", "/datasets/" + project + "/images/geo.txt",
        *rcfg.get("odm_args", []),
    ]
    log.info("running: %s", " ".join(cmd))
    if rcfg.get("dry_run", False):
        log.warning("reconstruct.dry_run = true -> command printed, not executed")
        return
    if not shutil.which("docker"):
        raise RuntimeError("docker not found. Install Docker Desktop or set reconstruct.dry_run: true")
    subprocess.run(cmd, check=True)
    log.info("reconstruction finished: %s", odm_root / project)
