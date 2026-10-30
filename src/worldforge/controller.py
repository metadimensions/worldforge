from __future__ import annotations

import math
from dataclasses import dataclass

from .environment import Environment
from .geometry import segment_samples
from .models import Obstacle, Point, Scenario
from .planner import plan_path


@dataclass
class ControlStep:
    position: Point
    heading: float
    status: str


class WaypointController:
    def __init__(self, scenario: Scenario, env: Environment, path: list[Point]):
        self.sc = scenario
        self.env = env
        self.path = list(path)
        self.index = 1 if len(path) > 1 else 0
        self.blocked_steps = 0
        self.replans: list[dict] = []

    @property
    def target(self) -> Point:
        return self.path[self.index]

    def _step_is_clear(self, a: Point, b: Point, obstacles: list[Obstacle]) -> bool:
        spacing = max(self.sc.robot_radius / 4, 0.5)
        return all(self.env.collision(p, self.sc.robot_radius, obstacles) is None
                   for p in segment_samples(a, b, spacing))

    def _replan(self, pos: Point, t: float, obstacles: list[Obstacle]) -> bool:
        new_path = plan_path(pos, self.sc.goal, obstacles, self.sc.width, self.sc.height,
                             self.sc.grid_resolution, self.sc.robot_radius + self.sc.safety_margin,
                             allow_occupied_start=True)
        self.replans.append({"t": round(t, 6), "found": new_path is not None, "path": new_path or []})
        if new_path is None:
            return False
        self.path = new_path
        self.index = 1 if len(new_path) > 1 else 0
        return True

    def step(self, pos: Point, heading: float, t: float, obstacles: list[Obstacle]) -> ControlStep:
        while self.index < len(self.path) - 1 and math.dist(pos, self.target) <= self.sc.waypoint_tolerance:
            self.index += 1

        target = self.target
        dist = math.dist(pos, target)
        if dist < 1e-9:
            return ControlStep(pos, heading, "arrived")

        step_len = min(self.sc.max_speed * self.sc.dt, dist)
        ux, uy = (target[0] - pos[0]) / dist, (target[1] - pos[1]) / dist
        candidate = (pos[0] + ux * step_len, pos[1] + uy * step_len)

        if self._step_is_clear(pos, candidate, obstacles):
            self.blocked_steps = 0
            return ControlStep(candidate, math.atan2(uy, ux), "moving")

        self.blocked_steps += 1
        if self.blocked_steps % self.sc.replan_after_blocked_steps == 0:
            if self._replan(pos, t, obstacles):
                return ControlStep(pos, heading, "replanned")
        return ControlStep(pos, heading, "waiting")
