"""Drone video/images -> 3D inspection map : pipeline runner.

    python -m pipeline.run --config pipeline/config.example.yaml --campaign 2026
    python -m pipeline.run --config ... --campaign 2026 --stages detect,localize,assess,export
    python -m pipeline.run --list

Each stage reads the previous stage's output from <workspace>/<campaign>/NN_name/ so any stage
can be re-run on its own (e.g. re-run detection with a new model without redoing 3D).
"""
from __future__ import annotations

import argparse
import logging
import sys
import time
from pathlib import Path

from .core import Context, log
from .stages import s1_ingest, s2_keyframes, s3_reconstruct, s4_detect, s5_localize, s6_assess, s7_export

STAGES = [
    ("ingest", s1_ingest, "inventory media, parse DJI .SRT / XMP GNSS"),
    ("keyframes", s2_keyframes, "distance-based frame sampling + blur filter, geo.txt"),
    ("reconstruct", s3_reconstruct, "SfM/MVS with OpenDroneMap -> point cloud, mesh, 3D Tiles"),
    ("detect", s4_detect, "AI damage detection / segmentation on keyframes"),
    ("localize", s5_localize, "ray-cast to 3D, multi-view fusion, chainage, ID tracking"),
    ("assess", s6_assess, "severity, component, history merge"),
    ("export", s7_export, "viewer data (inspection.js), GeoJSON, CSV"),
]


def load_config(path: Path) -> dict:
    import yaml  # PyYAML
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", type=Path, default=Path(__file__).with_name("config.example.yaml"))
    ap.add_argument("--campaign", help="campaign id, e.g. 2026 (folder under workspace/)")
    ap.add_argument("--stages", default="all", help="comma separated stage names, or 'all'")
    ap.add_argument("--list", action="store_true", help="list stages and exit")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname).1s %(message)s", datefmt="%H:%M:%S")
    if args.list:
        for i, (name, _, desc) in enumerate(STAGES, 1):
            print(f"{i}. {name:<12} {desc}")
        return 0
    if not args.campaign:
        ap.error("--campaign is required")

    cfg = load_config(args.config)
    ctx = Context(cfg, args.campaign)
    wanted = [s[0] for s in STAGES] if args.stages == "all" else [s.strip() for s in args.stages.split(",")]
    unknown = set(wanted) - {s[0] for s in STAGES}
    if unknown:
        ap.error(f"unknown stage(s): {', '.join(sorted(unknown))}")

    log.info("campaign %s, workspace %s", args.campaign, ctx.ws)
    for name, mod, _ in STAGES:
        if name not in wanted:
            continue
        t0 = time.time()
        log.info("=== %s ===", name)
        mod.run(ctx)
        log.info("=== %s done in %.1fs ===", name, time.time() - t0)
    return 0


if __name__ == "__main__":
    sys.exit(main())
