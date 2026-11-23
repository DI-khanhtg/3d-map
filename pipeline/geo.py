"""Geometry helpers: distances, local ENU, and linear referencing along a rail centreline.

Linear referencing ("kiro-tei" / chainage) is the bridge between the 3D world and how
railway engineers think: every defect is reported as "line JY, 28.695 km, section JY-S143".
Only the standard library is used so this module is easy to test.
"""
from __future__ import annotations

import bisect
import math
from dataclasses import dataclass

R_EARTH = 6_371_008.8
DEG = math.pi / 180.0


def haversine(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Distance in metres between (lon, lat) points."""
    dlat = (b[1] - a[1]) * DEG
    dlon = (b[0] - a[0]) * DEG
    h = math.sin(dlat / 2) ** 2 + math.cos(a[1] * DEG) * math.cos(b[1] * DEG) * math.sin(dlon / 2) ** 2
    return 2 * R_EARTH * math.asin(min(1.0, math.sqrt(h)))


def to_enu(lon: float, lat: float, lon0: float, lat0: float) -> tuple[float, float]:
    """Equirectangular approximation (fine for < 10 km): returns (east, north) in metres."""
    return ((lon - lon0) * DEG * R_EARTH * math.cos(lat0 * DEG), (lat - lat0) * DEG * R_EARTH)


def from_enu(e: float, n: float, lon0: float, lat0: float) -> tuple[float, float]:
    return (lon0 + e / (R_EARTH * math.cos(lat0 * DEG)) / DEG, lat0 + n / R_EARTH / DEG)


def offset_point(lon: float, lat: float, bearing_deg: float, dist_m: float) -> tuple[float, float]:
    """Move a point dist_m metres along a compass bearing (0 = north, clockwise)."""
    b = bearing_deg * DEG
    return from_enu(math.sin(b) * dist_m, math.cos(b) * dist_m, lon, lat)


@dataclass
class Projection:
    chainage_m: float   # distance along the line
    offset_m: float     # signed lateral offset (+ = right of travel direction)
    lon: float          # foot point on the centreline
    lat: float
    bearing_deg: float  # direction of the line at the foot point


class LineRef:
    """Linear referencing on a polyline given as [[lon, lat], ...]."""

    def __init__(self, coords: list[list[float]], closed: bool = False):
        if len(coords) < 2:
            raise ValueError("need at least 2 vertices")
        self.coords = [(float(c[0]), float(c[1])) for c in coords]
        self.closed = closed
        self.cum = [0.0]
        for i in range(1, len(self.coords)):
            self.cum.append(self.cum[-1] + haversine(self.coords[i - 1], self.coords[i]))
        self.length = self.cum[-1]

    def point_at(self, s: float) -> tuple[float, float, float]:
        """(lon, lat, bearing_deg) at chainage s (wraps around if the line is closed)."""
        s = s % self.length if self.closed else min(max(s, 0.0), self.length)
        i = max(1, min(len(self.cum) - 1, bisect.bisect_right(self.cum, s)))
        a, b = self.coords[i - 1], self.coords[i]
        seg = self.cum[i] - self.cum[i - 1]
        t = 0.0 if seg == 0 else (s - self.cum[i - 1]) / seg
        lon = a[0] + (b[0] - a[0]) * t
        lat = a[1] + (b[1] - a[1]) * t
        e, n = to_enu(b[0], b[1], a[0], a[1])
        return lon, lat, (math.degrees(math.atan2(e, n)) + 360) % 360

    def project(self, lon: float, lat: float) -> Projection:
        """Nearest point on the line (brute force; O(n) is fine for a few thousand vertices)."""
        best: Projection | None = None
        best_d = float("inf")
        for i in range(1, len(self.coords)):
            a, b = self.coords[i - 1], self.coords[i]
            bx, by = to_enu(b[0], b[1], a[0], a[1])
            px, py = to_enu(lon, lat, a[0], a[1])
            seg2 = bx * bx + by * by
            t = 0.0 if seg2 == 0 else max(0.0, min(1.0, (px * bx + py * by) / seg2))
            fx, fy = bx * t, by * t
            d = math.hypot(px - fx, py - fy)
            if d < best_d:
                best_d = d
                cross = bx * py - by * px              # > 0 : point is left of a->b
                flon, flat = from_enu(fx, fy, a[0], a[1])
                best = Projection(
                    chainage_m=self.cum[i - 1] + t * math.sqrt(seg2),
                    offset_m=-math.copysign(d, cross) if cross != 0 else 0.0,
                    lon=flon, lat=flat,
                    bearing_deg=(math.degrees(math.atan2(bx, by)) + 360) % 360,
                )
        assert best is not None
        return best
