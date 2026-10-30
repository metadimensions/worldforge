from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass, field
from typing import Any, Literal

Point = tuple[float, float]

ShapeKind = Literal["rect", "circle"]
Outcome = Literal["success", "collision", "timeout", "no_path", "stuck"]
OUTCOMES: tuple[str, ...] = ("success", "collision", "timeout", "no_path", "stuck")


@dataclass
class Obstacle:

    id: str
    kind: ShapeKind
    x: float
    y: float
    width: float = 0.0
    height: float = 0.0
    radius: float = 0.0

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Obstacle:
        return cls(**d)


@dataclass
class MovingObstacle:

    id: str
    kind: ShapeKind
    path: list[Point]
    speed: float
    width: float = 0.0
    height: float = 0.0
    radius: float = 0.0
    start_time: float = 0.0
    mode: Literal["once", "pingpong", "loop"] = "once"

    def position_at(self, t: float) -> Point:
        pts = [tuple(p) for p in self.path]
        if len(pts) == 1 or self.speed <= 0 or t <= self.start_time:
            return pts[0]
        if self.mode == "loop":
            pts = pts + [pts[0]]
        seg_lengths = [math.dist(a, b) for a, b in zip(pts, pts[1:])]
        total = sum(seg_lengths)
        if total == 0:
            return pts[0]
        s = (t - self.start_time) * self.speed
        if self.mode == "once":
            s = min(s, total)
        elif self.mode == "loop":
            s = s % total
        else:
            s = s % (2 * total)
            if s > total:
                s = 2 * total - s
        for (a, b), length in zip(zip(pts, pts[1:]), seg_lengths):
            if s <= length:
                f = 0.0 if length == 0 else s / length
                return (a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)
            s -= length
        return pts[-1]

    def at(self, t: float) -> Obstacle:
        x, y = self.position_at(t)
        return Obstacle(self.id, self.kind, x, y, self.width, self.height, self.radius)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> MovingObstacle:
        d = dict(d)
        d["path"] = [tuple(p) for p in d["path"]]
        return cls(**d)


@dataclass
class Scenario:
    id: str
    description: str = ""
    width: float = 800.0
    height: float = 600.0
    start: Point = (60.0, 300.0)
    goal: Point = (740.0, 300.0)
    robot_radius: float = 15.0
    max_speed: float = 80.0
    dt: float = 0.05
    max_steps: int = 1200
    goal_tolerance: float = 8.0
    grid_resolution: float = 10.0
    safety_margin: float = 5.0
    waypoint_tolerance: float = 4.0
    stuck_window: int = 100
    stuck_min_progress: float = 10.0
    replan_after_blocked_steps: int = 20
    start_jitter: float = 0.0
    static_obstacles: list[Obstacle] = field(default_factory=list)
    moving_obstacles: list[MovingObstacle] = field(default_factory=list)
    expected_outcome: str | None = None
    failure_explanation: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def to_json(self, **kwargs: Any) -> str:
        return json.dumps(self.to_dict(), **kwargs)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Scenario:
        d = dict(d)
        d["start"] = tuple(d["start"])
        d["goal"] = tuple(d["goal"])
        d["static_obstacles"] = [Obstacle.from_dict(o) for o in d.get("static_obstacles", [])]
        d["moving_obstacles"] = [MovingObstacle.from_dict(o) for o in d.get("moving_obstacles", [])]
        return cls(**d)

    @classmethod
    def from_json(cls, s: str) -> Scenario:
        return cls.from_dict(json.loads(s))


@dataclass
class TrajectoryPoint:
    t: float
    x: float
    y: float
    heading: float
    status: str


@dataclass
class CollisionInfo:
    t: float
    step: int
    x: float
    y: float
    obstacle_id: str


@dataclass
class SimulationResult:
    scenario_id: str
    seed: int
    outcome: Outcome
    reason: str
    steps: int
    duration: float
    goal: Point
    start: Point
    planned_path: list[Point]
    trajectory: list[TrajectoryPoint]
    metrics: dict[str, Any]
    collision: CollisionInfo | None = None
    replans: list[dict[str, Any]] = field(default_factory=list)
    diagnostics: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def to_json(self, **kwargs: Any) -> str:
        return json.dumps(self.to_dict(), **kwargs)

    @property
    def failure_details(self) -> dict[str, Any] | None:
        if self.outcome == "success":
            return None
        return {
            "outcome": self.outcome,
            "reason": self.reason,
            "collision": asdict(self.collision) if self.collision else None,
            "diagnostics": self.diagnostics or None,
        }
