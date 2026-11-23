"""Stage 4 — AI damage detection on keyframes.

Input   02_frames/frames.json (+ images)
Output  04_detect/detections.json   list[Detection]

Model: instance segmentation (e.g. YOLOv8/YOLO11-seg) fine-tuned on 7 classes:
    crack, spalling, rebar, rust, leak, deform, missing
Cracks are thin (often 0.2 mm ≈ 1-3 px), so images are processed in overlapping tiles
(SAHI-style) at full resolution instead of being resized to 640 px.

Measurement: mask -> skeleton length / mean width in pixels; stage 5 converts to mm with the
ground-sample distance (GSD) at the 3D hit point.

The `Detector` protocol keeps the model swappable (in-house model, vendor API, or the
MockDetector used for dry runs).
"""
from __future__ import annotations

import random
from typing import Iterable, Protocol

from ..core import Context, Detection, log, read_json, write_json

CLASSES = ["crack", "spalling", "rebar", "rust", "leak", "deform", "missing"]


class Detector(Protocol):
    def detect(self, image_path: str, frame_id: str) -> Iterable[Detection]: ...


class MockDetector:
    """Random detections - only for exercising the pipeline end to end."""

    def __init__(self, rate: float = 0.03, seed: int = 0):
        self.rate, self.rng = rate, random.Random(seed)

    def detect(self, image_path: str, frame_id: str) -> Iterable[Detection]:
        if self.rng.random() < self.rate:
            x, y = self.rng.uniform(500, 3000), self.rng.uniform(400, 1700)
            yield Detection(frame_id=frame_id, cls=self.rng.choice(CLASSES), conf=round(self.rng.uniform(0.5, 0.95), 2),
                            bbox=[x, y, x + 240, y + 160], length_px=self.rng.uniform(40, 400), width_px=self.rng.uniform(1, 6))


class YoloSegDetector:
    """Ultralytics YOLO-seg with simple tiling. Requires: ultralytics, numpy, opencv-python."""

    def __init__(self, weights: str, tile: int = 1280, overlap: float = 0.2, conf: float = 0.35, device: str | None = None):
        from ultralytics import YOLO  # lazy
        self.model = YOLO(weights)
        self.tile, self.overlap, self.conf, self.device = tile, overlap, conf, device

    def detect(self, image_path: str, frame_id: str) -> Iterable[Detection]:
        import cv2
        import numpy as np
        img = cv2.imread(image_path)
        if img is None:
            return
        h, w = img.shape[:2]
        step = int(self.tile * (1 - self.overlap))
        margin = int(self.overlap * self.tile)
        for y0 in range(0, max(1, h - margin), step):
            for x0 in range(0, max(1, w - margin), step):
                crop = img[y0:y0 + self.tile, x0:x0 + self.tile]
                res = self.model.predict(crop, conf=self.conf, device=self.device, verbose=False)[0]
                if res.boxes is None:
                    continue
                masks = res.masks.data.cpu().numpy() if res.masks is not None else None
                for i, b in enumerate(res.boxes):
                    x1, y1, x2, y2 = (float(v) for v in b.xyxy[0].tolist())
                    cls = res.names[int(b.cls)]
                    area = length = width = 0.0
                    if masks is not None:
                        m = masks[i] > 0.5
                        area = float(m.sum())
                        # crude skeleton length: longer side of the mask's bounding box;
                        # replace with skimage.morphology.skeletonize for production
                        ys, xs = np.nonzero(m)
                        if len(xs):
                            length = float(max(np.ptp(xs), np.ptp(ys)))
                            width = area / max(length, 1.0)
                    yield Detection(frame_id=frame_id, cls=cls, conf=float(b.conf),
                                    bbox=[x1 + x0, y1 + y0, x2 + x0, y2 + y0],
                                    mask_area_px=area, length_px=length, width_px=width)
        # NOTE: duplicates across tile overlaps are merged later by spatial clustering (stage 5)


def make_detector(cfg: dict) -> Detector:
    kind = cfg.get("kind", "mock")
    if kind == "yolo":
        return YoloSegDetector(cfg["weights"], tile=cfg.get("tile", 1280), overlap=cfg.get("overlap", 0.2),
                               conf=cfg.get("conf", 0.35), device=cfg.get("device"))
    return MockDetector(rate=cfg.get("mock_rate", 0.03))


def run(ctx: Context) -> None:
    det = make_detector(ctx.cfg["detect"])
    frames = read_json(ctx.ws / "02_frames" / "frames.json")
    out: list[Detection] = []
    for i, f in enumerate(frames):
        out.extend(det.detect(f["image"], f["id"]))
        if i % 500 == 0:
            log.info("detect: %d/%d frames, %d detections", i, len(frames), len(out))
    write_json(ctx.stage_dir("04_detect") / "detections.json", out)
