from __future__ import annotations

import math

from .geometry import circle_hits_walls, distance_to_obstacle, distance_to_walls
from .models import Obstacle, Point, Scenario


class Environment:
    def __init__(self, scenario: Scenario):
        self.scenario = scenario
        self.width = scenario.width
        self.height = scenario.height
        self.static_obstacles = list(scenario.static_obstacles)
        self.moving_obstacles = list(scenario.moving_obstacles)

    def obstacles_at(self, t: float) -> list[Obstacle]:
        return self.static_obstacles + [m.at(t) for m in self.moving_obstacles]

    def collision(self, p: Point, radius: float, obstacles: list[Obstacle]) -> str | None:
        if circle_hits_walls(p, radius, self.width, self.height):
            return "wall"
        for obs in obstacles:
            if distance_to_obstacle(p, obs) < radius:
                return obs.id
        return None

    def clearance(self, p: Point, radius: float, obstacles: list[Obstacle]) -> float:
        if not obstacles:
            return math.inf
        return min(distance_to_obstacle(p, o) for o in obstacles) - radius

    def wall_clearance(self, p: Point, radius: float) -> float:
        return distance_to_walls(p, self.width, self.height) - radius
