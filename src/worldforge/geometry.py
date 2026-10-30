from __future__ import annotations

import math

from .models import Obstacle, Point


def point_to_rect_distance(px: float, py: float, cx: float, cy: float, w: float, h: float) -> float:
    dx = abs(px - cx) - w / 2
    dy = abs(py - cy) - h / 2
    outside = math.hypot(max(dx, 0.0), max(dy, 0.0))
    inside = min(max(dx, dy), 0.0)
    return outside + inside


def point_to_circle_distance(px: float, py: float, cx: float, cy: float, r: float) -> float:
    return math.hypot(px - cx, py - cy) - r


def distance_to_obstacle(p: Point, obs: Obstacle) -> float:
    if obs.kind == "rect":
        return point_to_rect_distance(p[0], p[1], obs.x, obs.y, obs.width, obs.height)
    if obs.kind == "circle":
        return point_to_circle_distance(p[0], p[1], obs.x, obs.y, obs.radius)
    raise ValueError(f"unknown obstacle kind: {obs.kind!r}")


def distance_to_walls(p: Point, width: float, height: float) -> float:
    return min(p[0], p[1], width - p[0], height - p[1])


def circle_hits_obstacle(p: Point, radius: float, obs: Obstacle) -> bool:
    return distance_to_obstacle(p, obs) < radius


def circle_hits_walls(p: Point, radius: float, width: float, height: float) -> bool:
    return distance_to_walls(p, width, height) < radius


def segment_samples(a: Point, b: Point, max_spacing: float) -> list[Point]:
    length = math.dist(a, b)
    n = max(1, math.ceil(length / max_spacing))
    return [(a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n) for i in range(1, n + 1)]


def path_length(points: list[Point]) -> float:
    return sum(math.dist(a, b) for a, b in zip(points, points[1:]))
