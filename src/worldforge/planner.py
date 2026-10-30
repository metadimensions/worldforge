from __future__ import annotations

import heapq
import math

import numpy as np

from .models import Obstacle, Point

Cell = tuple[int, int]

SQRT2 = math.sqrt(2.0)


class OccupancyGrid:

    def __init__(self, width: float, height: float, resolution: float,
                 obstacles: list[Obstacle], inflation: float):
        if resolution <= 0:
            raise ValueError("resolution must be positive")
        self.width = width
        self.height = height
        self.resolution = resolution
        self.cols = int(math.ceil(width / resolution))
        self.rows = int(math.ceil(height / resolution))

        xs = (np.arange(self.cols) + 0.5) * resolution
        ys = (np.arange(self.rows) + 0.5) * resolution
        cx, cy = np.meshgrid(xs, ys)

        wall_dist = np.minimum.reduce([cx, cy, width - cx, height - cy])
        occupied = wall_dist < inflation
        for obs in obstacles:
            if obs.kind == "rect":
                dx = np.abs(cx - obs.x) - obs.width / 2
                dy = np.abs(cy - obs.y) - obs.height / 2
                dist = np.hypot(np.maximum(dx, 0), np.maximum(dy, 0)) + np.minimum(np.maximum(dx, dy), 0)
            elif obs.kind == "circle":
                dist = np.hypot(cx - obs.x, cy - obs.y) - obs.radius
            else:
                raise ValueError(f"unknown obstacle kind: {obs.kind!r}")
            occupied |= dist < inflation
        self.occupied = occupied

    def world_to_cell(self, p: Point) -> Cell:
        col = min(max(int(p[0] // self.resolution), 0), self.cols - 1)
        row = min(max(int(p[1] // self.resolution), 0), self.rows - 1)
        return col, row

    def cell_to_world(self, c: Cell) -> Point:
        return ((c[0] + 0.5) * self.resolution, (c[1] + 0.5) * self.resolution)

    def in_bounds(self, c: Cell) -> bool:
        return 0 <= c[0] < self.cols and 0 <= c[1] < self.rows

    def is_free(self, c: Cell) -> bool:
        return self.in_bounds(c) and not self.occupied[c[1], c[0]]


_NEIGHBOURS = [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)]


def astar(grid: OccupancyGrid, start: Cell, goal: Cell, allow_occupied_start: bool = False) -> list[Cell] | None:
    if not grid.is_free(goal):
        return None
    if not grid.in_bounds(start) or (not allow_occupied_start and not grid.is_free(start)):
        return None

    def h(c: Cell) -> float:
        dx, dy = abs(c[0] - goal[0]), abs(c[1] - goal[1])
        return (dx + dy) + (SQRT2 - 2) * min(dx, dy)

    open_heap: list[tuple[float, int, Cell]] = [(h(start), 0, start)]
    g: dict[Cell, float] = {start: 0.0}
    came_from: dict[Cell, Cell] = {}
    closed: set[Cell] = set()
    counter = 0

    while open_heap:
        _, _, cur = heapq.heappop(open_heap)
        if cur == goal:
            path = [cur]
            while cur in came_from:
                cur = came_from[cur]
                path.append(cur)
            return path[::-1]
        if cur in closed:
            continue
        closed.add(cur)
        for dx, dy in _NEIGHBOURS:
            nxt = (cur[0] + dx, cur[1] + dy)
            if not grid.is_free(nxt) or nxt in closed:
                continue
            if dx and dy and not (grid.is_free((cur[0] + dx, cur[1])) and grid.is_free((cur[0], cur[1] + dy))):
                continue
            cost = g[cur] + (SQRT2 if dx and dy else 1.0)
            if cost < g.get(nxt, math.inf):
                g[nxt] = cost
                came_from[nxt] = cur
                counter += 1
                heapq.heappush(open_heap, (cost + h(nxt), counter, nxt))
    return None


def _prune_collinear(points: list[Point]) -> list[Point]:
    if len(points) <= 2:
        return points
    out = [points[0]]
    for prev, cur, nxt in zip(points, points[1:], points[2:]):
        cross = (cur[0] - prev[0]) * (nxt[1] - cur[1]) - (cur[1] - prev[1]) * (nxt[0] - cur[0])
        if abs(cross) > 1e-9:
            out.append(cur)
    out.append(points[-1])
    return out


def plan_path(start: Point, goal: Point, obstacles: list[Obstacle], width: float, height: float,
              resolution: float, inflation: float, allow_occupied_start: bool = False) -> list[Point] | None:
    grid = OccupancyGrid(width, height, resolution, obstacles, inflation)
    cells = astar(grid, grid.world_to_cell(start), grid.world_to_cell(goal), allow_occupied_start)
    if cells is None:
        return None
    pts = [grid.cell_to_world(c) for c in cells]
    pts[0] = (float(start[0]), float(start[1]))
    if len(pts) == 1:
        pts.append((float(goal[0]), float(goal[1])))
    else:
        pts[-1] = (float(goal[0]), float(goal[1]))
    return _prune_collinear(pts)


def _free_region(grid: OccupancyGrid, seed: Cell) -> set[Cell]:
    region, stack = {seed}, [seed]
    while stack:
        c, r = stack.pop()
        for nxt in ((c + 1, r), (c - 1, r), (c, r + 1), (c, r - 1)):
            if nxt not in region and grid.is_free(nxt):
                region.add(nxt)
                stack.append(nxt)
    return region


def _obstacles_occupying(grid: OccupancyGrid, cells: set[Cell], obstacles: list[Obstacle],
                         inflation: float) -> list[str]:
    from .geometry import distance_to_obstacle, distance_to_walls

    ids: list[str] = []
    for cell in sorted(cells):
        p = grid.cell_to_world(cell)
        if "boundary" not in ids and distance_to_walls(p, grid.width, grid.height) < inflation:
            ids.append("boundary")
        for obs in obstacles:
            if obs.id not in ids and distance_to_obstacle(p, obs) < inflation:
                ids.append(obs.id)
    return ids


def diagnose_no_path(start: Point, goal: Point, obstacles: list[Obstacle], width: float, height: float,
                     resolution: float, inflation: float) -> dict:
    grid = OccupancyGrid(width, height, resolution, obstacles, inflation)
    s, g = grid.world_to_cell(start), grid.world_to_cell(goal)

    if not grid.is_free(g):
        ids = _obstacles_occupying(grid, {g}, obstacles, inflation)
        return {"blocked": "goal_in_obstacle", "blocking_obstacle_ids": ids,
                "message": f"Goal is unreachable because it lies inside the inflated footprint of {', '.join(ids)}."}
    if not grid.is_free(s):
        ids = _obstacles_occupying(grid, {s}, obstacles, inflation)
        return {"blocked": "start_in_obstacle", "blocking_obstacle_ids": ids,
                "message": f"No route: the start lies inside the inflated footprint of {', '.join(ids)}."}

    goal_region = _free_region(grid, g)
    start_region = _free_region(grid, s)
    kind, region = (("goal_enclosed", goal_region) if len(goal_region) <= len(start_region)
                    else ("start_enclosed", start_region))
    border = {(c + dc, r + dr) for c, r in region for dc, dr in ((1, 0), (-1, 0), (0, 1), (0, -1))
              if grid.in_bounds((c + dc, r + dr)) and not grid.is_free((c + dc, r + dr))}
    ids = _obstacles_occupying(grid, border, obstacles, inflation)
    who = "Goal" if kind == "goal_enclosed" else "Start"
    return {"blocked": kind, "blocking_obstacle_ids": ids,
            "message": (f"{who} is unreachable because the static obstacle map blocks all valid routes: "
                        f"it is enclosed by {', '.join(ids)}.")}
